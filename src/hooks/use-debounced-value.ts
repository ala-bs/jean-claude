import { useEffect, useState } from 'react';

export function createDebouncedPublisher<T>(
  delay: number,
  publish: (value: T) => void,
): { schedule: (value: T) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return {
    schedule(value) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => publish(value), delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [published, setPublished] = useState(value);

  useEffect(() => {
    const publisher = createDebouncedPublisher(delay, setPublished);
    publisher.schedule(value);

    return publisher.cancel;
  }, [value, delay]);

  return published;
}
