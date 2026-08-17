import { contextBridge, ipcRenderer } from 'electron';

declare global {
  var reactNativeDecorateInspectorFrontendHostInstance:
    | ((host: { bringToFront: () => void }) => void)
    | undefined;
}

contextBridge.executeInMainWorld({
  func: (ipcDevTools: { bringToFront: () => void }) => {
    let didDecorateInspectorFrontendHostInstance = false;
    globalThis.reactNativeDecorateInspectorFrontendHostInstance = (
      InspectorFrontendHostInstance: { bringToFront: () => void },
    ) => {
      didDecorateInspectorFrontendHostInstance = true;
      InspectorFrontendHostInstance.bringToFront = () => {
        ipcDevTools.bringToFront();
      };
    };
    document.addEventListener('DOMContentLoaded', () => {
      if (!didDecorateInspectorFrontendHostInstance) {
        console.error(
          'reactNativeDecorateInspectorFrontendHostInstance was not called at startup. ' +
            'This version of the DevTools frontend may not be compatible with Jean-Claude embedded React Native DevTools.',
        );
      }
    });
  },
  args: [
    {
      bringToFront() {
        ipcRenderer.send('mobilePreview:embeddedReactNativeDevToolsBringToFront');
      },
    },
  ],
});

export {};
