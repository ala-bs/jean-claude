import { AlertTriangle, Terminal } from 'lucide-react';
import type { SVGProps } from 'react';

import { getPreviewErrorInfo } from '../utils-preview-error';
import type { MobilePlatform } from '@shared/mobile-simulator-types';

export function IconAppleLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="-1.5 0 20 20" aria-hidden="true" fill="currentColor" {...props}>
      <g transform="translate(-102 -7439)">
        <g transform="translate(56 160)">
          <path d="M57.5708873,7282.19296 C58.2999598,7281.34797 58.7914012,7280.17098 58.6569121,7279 C57.6062792,7279.04 56.3352055,7279.67099 55.5818643,7280.51498 C54.905374,7281.26397 54.3148354,7282.46095 54.4735932,7283.60894 C55.6455696,7283.69593 56.8418148,7283.03894 57.5708873,7282.19296 M60.1989864,7289.62485 C60.2283111,7292.65181 62.9696641,7293.65879 63,7293.67179 C62.9777537,7293.74279 62.562152,7295.10677 61.5560117,7296.51675 C60.6853718,7297.73474 59.7823735,7298.94772 58.3596204,7298.97372 C56.9621472,7298.99872 56.5121648,7298.17973 54.9134635,7298.17973 C53.3157735,7298.17973 52.8162425,7298.94772 51.4935978,7298.99872 C50.1203933,7299.04772 49.0738052,7297.68074 48.197098,7296.46676 C46.4032359,7293.98379 45.0330649,7289.44985 46.8734421,7286.3899 C47.7875635,7284.87092 49.4206455,7283.90793 51.1942837,7283.88393 C52.5422083,7283.85893 53.8153044,7284.75292 54.6394294,7284.75292 C55.4635543,7284.75292 57.0106846,7283.67793 58.6366882,7283.83593 C59.3172232,7283.86293 61.2283842,7284.09893 62.4549652,7285.8199 C62.355868,7285.8789 60.1747177,7287.09489 60.1989864,7289.62485" />
        </g>
      </g>
    </svg>
  );
}

export function IconAndroidLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="19.933 68.509 228.155 228.155" aria-hidden="true" fill="none" {...props}>
      <path d="M101.885 207.092c7.865 0 14.241 6.376 14.241 14.241v61.09c0 7.865-6.376 14.24-14.241 14.24-7.864 0-14.24-6.375-14.24-14.24v-61.09c0-7.864 6.376-14.24 14.24-14.24z" fill="currentColor" />
      <path d="M69.374 133.645c-.047.54-.088 1.086-.088 1.638v92.557c0 9.954 7.879 17.973 17.66 17.973h94.124c9.782 0 17.661-8.02 17.661-17.973v-92.557c0-.552-.02-1.1-.066-1.638H69.374z" fill="currentColor" />
      <path d="M166.133 207.092c7.865 0 14.241 6.376 14.241 14.241v61.09c0 7.865-6.376 14.24-14.241 14.24-7.864 0-14.24-6.375-14.24-14.24v-61.09c0-7.864 6.376-14.24 14.24-14.24zM46.405 141.882c7.864 0 14.24 6.376 14.24 14.241v61.09c0 7.865-6.376 14.241-14.24 14.241-7.865 0-14.241-6.376-14.241-14.24v-61.09c-.001-7.865 6.375-14.242 14.241-14.242zM221.614 141.882c7.864 0 14.24 6.376 14.24 14.241v61.09c0 7.865-6.376 14.241-14.24 14.241-7.865 0-14.241-6.376-14.241-14.24v-61.09c0-7.865 6.376-14.242 14.241-14.242zM69.79 127.565c.396-28.43 25.21-51.74 57.062-54.812h14.312c31.854 3.073 56.666 26.384 57.062 54.812H69.79z" fill="currentColor" />
      <path d="M74.743 70.009l15.022 26.02M193.276 70.009l-15.023 26.02" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M114.878 102.087c.012 3.974-3.277 7.205-7.347 7.216-4.068.01-7.376-3.202-7.388-7.176v-.04c-.011-3.975 3.278-7.205 7.347-7.216 4.068-.011 7.376 3.2 7.388 7.176v.04zM169.874 102.087c.012 3.974-3.277 7.205-7.347 7.216-4.068.01-7.376-3.202-7.388-7.176v-.04c-.011-3.975 3.278-7.205 7.347-7.216 4.068-.011 7.376 3.2 7.388 7.176v.04z" fill="var(--color-bg-0)" />
    </svg>
  );
}

export function PlatformLogo({ platform }: { platform: MobilePlatform }) {
  const label = platform === 'ios' ? 'iOS' : 'Android';
  const Icon = platform === 'ios' ? IconAppleLogo : IconAndroidLogo;

  return (
    <span
      aria-label={label}
      title={label}
      className="text-acc-ink bg-acc-soft inline-flex size-5 items-center justify-center rounded-[3px]"
    >
      <Icon className="size-3.5" />
    </span>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div>
        <div className="text-ink-1 text-sm font-medium">{title}</div>
        {detail ? (
          <div className="text-ink-3 mt-1 text-xs">{detail}</div>
        ) : null}
      </div>
    </div>
  );
}

export function PreviewErrorState({ message }: { message: string }) {
  const info = getPreviewErrorInfo(message);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="border-border/70 bg-bg-1/70 w-full max-w-[520px] overflow-hidden rounded-2xl border shadow-[0_22px_80px_var(--color-scrim)]">
        <div className="border-border/60 flex items-start gap-3 border-b p-4">
          <div className="bg-status-warn/15 text-status-warn mt-0.5 rounded-xl p-2">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-ink-1 text-sm font-semibold">{info.title}</div>
            <div className="text-ink-3 mt-1 text-xs leading-relaxed">
              {info.summary}
            </div>
          </div>
        </div>

        {info.steps.length > 0 ? (
          <div className="space-y-2 p-4">
            <div className="text-ink-3 flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
              <Terminal className="h-3.5 w-3.5" />
              Setup steps
            </div>
            <div className="space-y-2">
              {info.steps.map((step) => (
                <code
                  key={step}
                  className="border-border/70 bg-bg-0 text-ink-1 block rounded-lg border px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
                >
                  {step}
                </code>
              ))}
            </div>
          </div>
        ) : null}

        {info.detail ? (
          <div className="border-border/60 text-ink-3 border-t px-4 py-3 text-[11px] leading-relaxed">
            {info.detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}
