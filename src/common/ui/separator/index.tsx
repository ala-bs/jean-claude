import clsx from 'clsx';

export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  return orientation === 'horizontal' ? (
    <div role="separator" className={clsx('separator-h shrink-0', className)} />
  ) : (
    <div
      role="separator"
      className={clsx('separator-v shrink-0 self-stretch', className)}
    />
  );
}
