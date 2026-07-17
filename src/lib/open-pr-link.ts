export function openPrLinkOnModifiedClick({
  event,
  url,
  open = window.open,
}: {
  event: { metaKey: boolean; ctrlKey: boolean };
  url?: string;
  open?: typeof window.open;
}) {
  if ((!event.metaKey && !event.ctrlKey) || !url) return false;

  open(url, '_blank', 'noopener,noreferrer');
  return true;
}
