import { RefreshCw } from 'lucide-react';
import { IconButton } from '@/common/ui/icon-button';
import { useProviders } from '@/hooks/use-providers';
import type { Provider } from '@shared/types';


import { OrganizationCard } from './organization-card';

export function OrganizationList({
  selectedProviderId,
  onSelectProvider,
}: {
  selectedProviderId: string | null;
  onSelectProvider: (provider: Provider | null) => void;
}) {
  const {
    data: providers = [],
    isFetching,
    refetch,
  } = useProviders();

  const azureDevOpsProviders = providers.filter(
    (p) => p.type === 'azure-devops',
  );

  const refreshButton = (
    <IconButton
      variant="ghost"
      size="sm"
      onClick={() => void refetch()}
      icon={<RefreshCw className={isFetching ? 'animate-spin' : undefined} />}
      tooltip="Refresh organizations"
      aria-label="Refresh organizations"
      disabled={isFetching}
    />
  );

  if (azureDevOpsProviders.length === 0) {
    return (
      <div className="border-glass-border rounded-lg border border-dashed px-6 py-8 text-center">
        <div className="mb-2 flex justify-end">{refreshButton}</div>
        <p className="text-ink-3">No organizations connected yet</p>
        <p className="text-ink-4 mt-1 text-sm">
          Click "Add Organization" to connect your Azure DevOps account
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">{refreshButton}</div>
      {azureDevOpsProviders.map((provider) => (
        <OrganizationCard
          key={provider.id}
          provider={provider}
          isSelected={selectedProviderId === provider.id}
          onSelect={() => {
            // Toggle selection if clicking the same provider
            if (selectedProviderId === provider.id) {
              onSelectProvider(null);
            } else {
              onSelectProvider(provider);
            }
          }}
        />
      ))}
    </div>
  );
}
