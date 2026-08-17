// Dumps the Mac's current keyboard layout as JSON:
//   {"inputSourceId":"...","keys":{"<char>":[<virtualKeyCode>,<shift 0|1>]}}
//
// The iOS Simulator interprets HID usage codes with the host keyboard layout,
// so typing a character through idb requires knowing which *physical* key
// produces it on the user's layout. UCKeyTranslate answers exactly that, for
// every layout (AZERTY, QWERTZ, Dvorak, ...) instead of a hardcoded table.

#import <Carbon/Carbon.h>
#import <Foundation/Foundation.h>

int main(void) {
  @autoreleasepool {
    TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
    if (!source) {
      fprintf(stderr, "No current keyboard layout input source.\n");
      return 1;
    }

    CFDataRef layoutData =
        (CFDataRef)TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
    if (!layoutData) {
      fprintf(stderr, "Current input source has no Unicode key layout data.\n");
      CFRelease(source);
      return 1;
    }

    const UCKeyboardLayout *layout = (const UCKeyboardLayout *)CFDataGetBytePtr(layoutData);
    NSString *inputSourceId =
        (__bridge NSString *)TISGetInputSourceProperty(source, kTISPropertyInputSourceID);
    UInt32 keyboardType = LMGetKbdType();

    NSMutableDictionary *keys = [NSMutableDictionary dictionary];
    // Unshifted first so it wins over the shifted variant for the same char.
    const UInt32 modifierStates[2] = {0, (shiftKey >> 8) & 0xff};

    for (int modifierIndex = 0; modifierIndex < 2; modifierIndex++) {
      for (UInt16 virtualKey = 0; virtualKey < 128; virtualKey++) {
        // Skip the numeric keypad: it produces the same characters as the main
        // row and would otherwise win (it is scanned first for unshifted
        // digits), while the simulator has no keypad to receive them.
        if (virtualKey >= 65 && virtualKey <= 92) continue;

        UInt32 deadKeyState = 0;
        UniChar chars[8] = {0};
        UniCharCount length = 0;

        // A dead key (^, ¨, ~ on European layouts) produces no character on its
        // own: the simulator would compose it with the next keystroke. Detect it
        // *without* kUCKeyTranslateNoDeadKeysBit and skip the key so the caller
        // falls back to paste.
        OSStatus deadStatus = UCKeyTranslate(layout, virtualKey, kUCKeyActionDown,
                                             modifierStates[modifierIndex], keyboardType, 0,
                                             &deadKeyState, sizeof(chars) / sizeof(chars[0]),
                                             &length, chars);
        if (deadStatus == noErr && length == 0 && deadKeyState != 0) continue;

        deadKeyState = 0;
        length = 0;
        OSStatus status = UCKeyTranslate(layout, virtualKey, kUCKeyActionDown,
                                         modifierStates[modifierIndex], keyboardType,
                                         kUCKeyTranslateNoDeadKeysBit, &deadKeyState,
                                         sizeof(chars) / sizeof(chars[0]), &length, chars);
        if (status != noErr || length != 1) continue;
        UniChar codeUnit = chars[0];
        // Control characters are driven through explicit key events, not text.
        if (codeUnit < 0x20 || codeUnit == 0x7f) continue;

        NSString *character = [NSString stringWithCharacters:&codeUnit length:1];
        if (keys[character]) continue;
        keys[character] = @[ @(virtualKey), @(modifierIndex) ];
      }
    }

    NSDictionary *dump = @{
      @"inputSourceId" : inputSourceId ?: @"",
      @"keys" : keys,
    };
    NSError *error = nil;
    NSData *json = [NSJSONSerialization dataWithJSONObject:dump options:0 error:&error];
    CFRelease(source);
    if (!json) {
      fprintf(stderr, "Failed to serialize keyboard layout: %s\n",
              error.localizedDescription.UTF8String);
      return 1;
    }

    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    return 0;
  }
}
