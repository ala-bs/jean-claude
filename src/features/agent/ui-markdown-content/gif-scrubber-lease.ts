export function createGifScrubberLeaseCoordinator() {
  let active: { revoke: () => void } | undefined;

  return {
    acquire(revoke: () => void) {
      active?.revoke();
      const lease = { revoke };
      active = lease;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (active === lease) active = undefined;
      };
    },
  };
}

export const gifScrubberLeaseCoordinator = createGifScrubberLeaseCoordinator();
