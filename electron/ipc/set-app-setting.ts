import type { AppSettings } from '@shared/types';

export async function setAppSetting<K extends keyof AppSettings>({
  key,
  value,
  persist,
  invalidateEureciaSession,
}: {
  key: K;
  value: AppSettings[K];
  persist: (key: K, value: AppSettings[K]) => Promise<void>;
  invalidateEureciaSession: () => void;
}) {
  await persist(key, value);
  if (key === 'eurecia') invalidateEureciaSession();
}
