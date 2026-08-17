import clsx from 'clsx';

export function getMobilePreviewStandaloneLayoutClasses({
  isStandalone,
  isInspectorOpen,
}: {
  isStandalone: boolean;
  isInspectorOpen: boolean;
}) {
  if (!isStandalone) {
    return {
      content: '',
      deviceRail: '',
      deviceRailResizeHandle: '',
      deviceList: '',
      deviceGroup: '',
      deviceButton: '',
      preview: '',
      inspector: '',
      inspectorToggle: 'hidden',
      inspectorClose: 'hidden',
    };
  }

  return {
    content: 'max-[900px]:flex-col',
    deviceRail:
      'max-[900px]:h-[126px] max-[900px]:w-full max-[900px]:border-r-0 max-[900px]:border-b',
    deviceRailResizeHandle: 'max-[900px]:hidden',
    deviceList: 'max-[900px]:overflow-x-auto max-[900px]:overflow-y-hidden',
    deviceGroup: 'max-[900px]:flex max-[900px]:gap-1.5',
    deviceButton: 'max-[900px]:w-[190px] max-[900px]:shrink-0',
    preview: 'min-w-[280px] max-[900px]:min-w-0',
    inspector: clsx(
      'max-[1180px]:absolute max-[1180px]:inset-y-0 max-[1180px]:right-0 max-[1180px]:z-30 max-[1180px]:max-w-full max-[1180px]:shadow-2xl',
      isInspectorOpen ? 'max-[1180px]:flex' : 'max-[1180px]:hidden',
    ),
    inspectorToggle: 'min-[1181px]:hidden',
    inspectorClose: 'min-[1181px]:hidden',
  };
}
