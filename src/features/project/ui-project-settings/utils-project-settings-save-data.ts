import type { UpdateProject } from '@shared/types';

export type ProjectSettingsSave = {
  data: UpdateProject;
  fieldVersions: Map<keyof UpdateProject, number>;
};

function pruneSavedFieldsFromQueuedSave(
  saved: ProjectSettingsSave,
  queued: ProjectSettingsSave,
): ProjectSettingsSave | null {
  const data = { ...queued.data };
  const fieldVersions = new Map(queued.fieldVersions);

  for (const [field, version] of saved.fieldVersions) {
    if (fieldVersions.get(field) !== version) continue;
    delete data[field];
    fieldVersions.delete(field);
  }

  return fieldVersions.size > 0 ? { data, fieldVersions } : null;
}

export function getProjectSettingsSaveData({
  data,
  dirtyFields,
}: {
  data: UpdateProject;
  dirtyFields: ReadonlySet<keyof UpdateProject>;
}): UpdateProject {
  const saveData: UpdateProject = {};

  for (const field of dirtyFields) {
    if (field in data) {
      saveData[field] = data[field] as never;
    }
  }

  return saveData;
}

export function flushProjectSettings({
  data,
  dirtyFields,
  dirtyFieldVersions,
  save,
}: {
  data: UpdateProject;
  dirtyFields: ReadonlySet<keyof UpdateProject>;
  dirtyFieldVersions: ReadonlyMap<keyof UpdateProject, number>;
  save: (save: ProjectSettingsSave) => void;
}): boolean {
  const saveData = getProjectSettingsSaveData({ data, dirtyFields });
  const fields = Object.keys(saveData) as (keyof UpdateProject)[];
  if (fields.length === 0) return false;

  save({
    data: saveData,
    fieldVersions: new Map(
      fields.map((field) => [field, dirtyFieldVersions.get(field) ?? 0]),
    ),
  });
  return true;
}

export function createProjectSettingsSaveQueue({
  save,
  onSuccess,
  onError,
}: {
  save: (save: ProjectSettingsSave) => Promise<unknown>;
  onSuccess: (
    save: ProjectSettingsSave,
    queuedSave: ProjectSettingsSave | null,
  ) => void;
  onError: (error: unknown) => void;
}): { enqueue: (save: ProjectSettingsSave) => Promise<void> } {
  let queuedSave: ProjectSettingsSave | null = null;
  let drainPromise: Promise<void> | null = null;

  async function drain() {
    while (queuedSave) {
      const nextSave = queuedSave;
      queuedSave = null;
      try {
        await save(nextSave);
        if (queuedSave) {
          queuedSave = pruneSavedFieldsFromQueuedSave(nextSave, queuedSave);
        }
        onSuccess(nextSave, queuedSave);
      } catch (error) {
        onError(error);
      }
    }
  }

  return {
    enqueue(nextSave) {
      queuedSave = nextSave;
      if (!drainPromise) {
        drainPromise = drain().finally(() => {
          drainPromise = null;
        });
      }
      return drainPromise;
    },
  };
}

export function createProjectSettingsAutosave({
  save,
  delay = 500,
}: {
  save: () => void;
  delay?: number;
}): { schedule: () => void; cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        save();
      }, delay);
    },
    cancel,
    flush() {
      cancel();
      save();
    },
  };
}
