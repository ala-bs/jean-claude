// electron/services/encryption-service.ts
import { safeStorage } from 'electron';

export const encryptionService = {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  },

  encrypt(plainText: string): string {
    return safeStorage.encryptString(plainText).toString('base64');
  },

  decrypt(encryptedBase64: string): string {
    return safeStorage.decryptString(Buffer.from(encryptedBase64, 'base64'));
  },
};
