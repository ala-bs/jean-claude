#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <ImageIO/ImageIO.h>
#import <dispatch/dispatch.h>
#import <objc/message.h>
#import <errno.h>
#import <signal.h>
#import <sys/stat.h>
#import <unistd.h>

static volatile sig_atomic_t gPaused = 0;
static volatile sig_atomic_t gForceFrame = 0;

// Emit a frame at least this often even when the framebuffer looks unchanged,
// so a consumer attaching to an idle simulator always gets a picture.
static const double kHeartbeatSeconds = 1.0;

static void HandlePauseSignal(int signal) {
  if (signal == SIGUSR1) gPaused = 1;
  if (signal == SIGUSR2) {
    gPaused = 0;
    gForceFrame = 1;
  }
}

/**
 * The helper must never outlive the Electron main process: an orphan keeps
 * encoding frames at full CPU forever. macOS has no PR_SET_PDEATHSIG, so watch
 * for re-parenting (getppid changes / becomes launchd) and for stdin EOF, which
 * the parent's pipe delivers as soon as it dies. Both run on a private queue so
 * they stay live while the main thread blocks in CoreSimulator startup.
 */
static void InstallParentDeathWatchdogs(void) {
  static dispatch_source_t watchdogTimer;
  static dispatch_source_t stdinSource;
  pid_t initialParentPid = getppid();
  dispatch_queue_t queue = dispatch_queue_create(
    "jean-claude.ios-framebuffer.watchdog", DISPATCH_QUEUE_SERIAL);

  watchdogTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
  dispatch_source_set_timer(
    watchdogTimer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_SEC / 4);
  dispatch_source_set_event_handler(watchdogTimer, ^{
    pid_t parentPid = getppid();
    if (parentPid != initialParentPid || parentPid <= 1) _exit(0);
  });
  dispatch_resume(watchdogTimer);

  // Only a pipe carries a meaningful EOF from the parent. Node's stdio: 'pipe'
  // is a socketpair, hence S_ISSOCK as well as S_ISFIFO. When stdin is a tty,
  // /dev/null or closed (manual runs, stdio: 'ignore'), reads return 0
  // immediately and would kill the helper on startup.
  struct stat stdinStat;
  if (fstat(STDIN_FILENO, &stdinStat) != 0) return;
  if (!S_ISFIFO(stdinStat.st_mode) && !S_ISSOCK(stdinStat.st_mode)) return;

  stdinSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, queue);
  dispatch_source_set_event_handler(stdinSource, ^{
    char scratch[256];
    ssize_t bytesRead = read(STDIN_FILENO, scratch, sizeof(scratch));
    // 0 is EOF (parent gone). A hard error other than a retryable one means the
    // pipe is unusable, so treat it as EOF instead of spinning on the source.
    if (bytesRead == 0) _exit(0);
    if (bytesRead < 0 && errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
      _exit(0);
    }
  });
  dispatch_resume(stdinSource);
}

static id SendId(id target, SEL selector) {
  return ((id (*)(id, SEL))objc_msgSend)(target, selector);
}

static id SendIdErr(id target, SEL selector, NSError **error) {
  return ((id (*)(id, SEL, NSError **))objc_msgSend)(target, selector, error);
}

static BOOL SendBoolErr(id target, SEL selector, NSError **error) {
  return ((BOOL (*)(id, SEL, NSError **))objc_msgSend)(target, selector, error);
}

static BOOL Responds(id object, NSString *selectorName) {
  return [object respondsToSelector:NSSelectorFromString(selectorName)];
}

static BOOL WriteAll(const uint8_t *bytes, NSUInteger length) {
  NSUInteger written = 0;
  while (written < length) {
    ssize_t result = write(STDOUT_FILENO, bytes + written, length - written);
    if (result <= 0) return NO;
    written += (NSUInteger)result;
  }
  return YES;
}

static NSData *CreateJpegData(IOSurfaceRef surface, CGFloat quality) {
  IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL);
  size_t width = IOSurfaceGetWidth(surface);
  size_t height = IOSurfaceGetHeight(surface);
  size_t bytesPerRow = IOSurfaceGetBytesPerRow(surface);
  void *baseAddress = IOSurfaceGetBaseAddress(surface);

  CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(
    baseAddress,
    width,
    height,
    8,
    bytesPerRow,
    colorSpace,
    kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little
  );
  CGImageRef image = context ? CGBitmapContextCreateImage(context) : NULL;
  NSMutableData *data = image ? [NSMutableData data] : nil;
  CGImageDestinationRef destination = data
    ? CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data, CFSTR("public.jpeg"), 1, NULL)
    : NULL;

  if (destination) {
    NSDictionary *properties = @{
      (__bridge NSString *)kCGImageDestinationLossyCompressionQuality: @(quality),
    };
    CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)properties);
    if (!CGImageDestinationFinalize(destination)) data = nil;
    CFRelease(destination);
  }

  if (image) CGImageRelease(image);
  if (context) CGContextRelease(context);
  CGColorSpaceRelease(colorSpace);
  IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
  return data;
}

static id FindDevice(NSString *udidString, NSString *developerDir, NSError **error) {
  Class contextClass = NSClassFromString(@"SimServiceContext");
  id context = ((id (*)(id, SEL, id, NSError **))objc_msgSend)(
    contextClass,
    NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:"),
    developerDir,
    error
  );
  if (!context) return nil;

  if (Responds(context, @"connectWithError:")) {
    if (!SendBoolErr(context, NSSelectorFromString(@"connectWithError:"), error)) {
      return nil;
    }
  }

  id deviceSet = SendIdErr(context, NSSelectorFromString(@"defaultDeviceSetWithError:"), error);
  if (!deviceSet) return nil;

  NSDictionary *devicesByUDID = SendId(deviceSet, NSSelectorFromString(@"devicesByUDID"));
  return devicesByUDID[udidString] ?: devicesByUDID[[[NSUUID alloc] initWithUUIDString:udidString]];
}

static id FindDisplayDescriptor(id device, NSError **error) {
  Class ioClass = NSClassFromString(@"SimDeviceIO");
  dispatch_queue_t errorQueue = dispatch_queue_create("jean-claude.ios-framebuffer.errors", DISPATCH_QUEUE_SERIAL);
  void (^errorHandler)(NSError *) = ^(NSError *ioError) {
    fprintf(stderr, "CoreSimulator IO error: %s\n", ioError.localizedDescription.UTF8String);
  };

  id io = ((id (*)(id, SEL, id, dispatch_queue_t, id, NSError **))objc_msgSend)(
    ioClass,
    NSSelectorFromString(@"ioForSimDevice:errorQueue:errorHandler:"),
    device,
    errorQueue,
    errorHandler,
    error
  );
  if (!io) return nil;

  NSArray *ports = SendId(io, NSSelectorFromString(@"ioPorts"));
  id fallbackDescriptor = nil;
  for (id port in ports) {
    id descriptor = Responds(port, @"descriptor") ? SendId(port, NSSelectorFromString(@"descriptor")) : nil;
    if (!descriptor || !Responds(descriptor, @"framebufferSurface")) continue;

    NSString *description = [descriptor description];
    BOOL isDisplay = [description containsString:@"SimDisplayIOSurfaceRenderable"] ||
      Responds(descriptor, @"registerScreenCallbacksWithUUID:callbackQueue:frameCallback:surfacesChangedCallback:propertiesChangedCallback:");
    if (!isDisplay) continue;

    if (!fallbackDescriptor) fallbackDescriptor = descriptor;
    IOSurfaceRef surface = (__bridge IOSurfaceRef)SendId(descriptor, NSSelectorFromString(@"framebufferSurface"));
    if (surface) return descriptor;
  }

  return fallbackDescriptor;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    signal(SIGUSR1, HandlePauseSignal);
    signal(SIGUSR2, HandlePauseSignal);
    if (argc < 2) {
      fprintf(stderr, "Usage: mobile-preview-ios-framebuffer <device-udid> [fps] [quality] [developer-dir]\n");
      return 64;
    }

    NSString *udid = [NSString stringWithUTF8String:argv[1]];
    double fps = argc > 2 ? atof(argv[2]) : 15.0;
    double quality = argc > 3 ? atof(argv[3]) : 0.65;
    NSString *developerDir = argc > 4
      ? [NSString stringWithUTF8String:argv[4]]
      : @"/Applications/Xcode.app/Contents/Developer";
    if (fps <= 0 || fps > 60) fps = 15.0;
    if (quality <= 0 || quality > 1) quality = 0.65;

    // Installed before the (blocking) CoreSimulator lookup so the helper can
    // never outlive its parent, even if startup hangs.
    InstallParentDeathWatchdogs();

    NSError *error = nil;
    id device = FindDevice(udid, developerDir, &error);
    if (!device) {
      fprintf(stderr, "CoreSimulator device not found: %s (%s)\n", udid.UTF8String, error.localizedDescription.UTF8String ?: "no error");
      return 2;
    }

    id descriptor = FindDisplayDescriptor(device, &error);
    if (!descriptor) {
      fprintf(stderr, "CoreSimulator display descriptor not found: %s (%s)\n", udid.UTF8String, error.localizedDescription.UTF8String ?: "no error");
      return 3;
    }

    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    uint64_t interval = (uint64_t)(NSEC_PER_SEC / fps);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0), interval, interval / 4);
    __block uint32_t lastSeed = 0;
    __block IOSurfaceID lastSurfaceId = 0;
    __block BOOL hasLastFrame = NO;
    __block uint64_t lastEmitUptimeNs = 0;
    const uint64_t heartbeatNs = (uint64_t)(kHeartbeatSeconds * NSEC_PER_SEC);
    dispatch_source_set_event_handler(timer, ^{
      @autoreleasepool {
        if (gPaused) return;
        IOSurfaceRef surface = (__bridge IOSurfaceRef)SendId(descriptor, NSSelectorFromString(@"framebufferSurface"));
        if (!surface) return;

        // Skip JPEG encoding when the simulator screen has not changed. This is
        // the bulk of the CPU cost on an idle simulator. A heartbeat (and an
        // explicit resume request) still forces a frame so late-joining or
        // resumed consumers never sit on a blank preview, and so a surface that
        // never bumps its seed cannot freeze the stream.
        uint32_t seed = IOSurfaceGetSeed(surface);
        IOSurfaceID surfaceId = IOSurfaceGetID(surface);
        // Monotonic: wall-clock jumps (NTP, sleep/wake) must not stall the
        // heartbeat.
        uint64_t nowNs = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
        BOOL forced = gForceFrame != 0;
        if (forced) gForceFrame = 0;
        BOOL heartbeatDue = (nowNs - lastEmitUptimeNs) >= heartbeatNs;
        BOOL unchanged =
          hasLastFrame && seed == lastSeed && surfaceId == lastSurfaceId;
        if (!forced && !heartbeatDue && unchanged) return;
        lastSeed = seed;
        lastSurfaceId = surfaceId;
        hasLastFrame = YES;
        lastEmitUptimeNs = nowNs;

        NSData *jpeg = CreateJpegData(surface, (CGFloat)quality);
        if (!jpeg || jpeg.length == 0) return;
        if (!WriteAll(jpeg.bytes, jpeg.length)) exit(0);
      }
    });
    dispatch_resume(timer);
    dispatch_main();
  }
}
