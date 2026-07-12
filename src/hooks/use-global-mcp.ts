import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { AgentBackendType } from '@shared/agent-backend-types';
import type {
  DiscoveredMcpVariant,
  NewGlobalMcpServer,
  UpdateGlobalMcpServer,
} from '@shared/global-mcp-types';
import { api } from '@/lib/api';

export function useGlobalMcpServers() {
  return useQuery({
    queryKey: ['globalMcpServers'],
    queryFn: () => api.globalMcp.findAll(),
  });
}

export function useGlobalMcpServer(id: string) {
  return useQuery({
    queryKey: ['globalMcpServers', id],
    queryFn: () => api.globalMcp.findById(id),
    enabled: !!id,
  });
}

export function useCreateGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: NewGlobalMcpServer) => api.globalMcp.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalMcpServers'] });
      queryClient.removeQueries({ queryKey: ['globalMcpServers', 'discover'] });
    },
  });
}

export function useUpdateGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateGlobalMcpServer;
    }) => api.globalMcp.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalMcpServers'] });
      queryClient.removeQueries({ queryKey: ['globalMcpServers', 'discover'] });
    },
  });
}

export function useEnableGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      backends,
    }: {
      id: string;
      backends: AgentBackendType[];
    }) => api.globalMcp.enable(id, backends),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalMcpServers'] });
      queryClient.removeQueries({ queryKey: ['globalMcpServers', 'discover'] });
    },
  });
}

export function useDisableGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      backends,
    }: {
      id: string;
      backends: AgentBackendType[];
    }) => api.globalMcp.disable(id, backends),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalMcpServers'] });
      queryClient.removeQueries({ queryKey: ['globalMcpServers', 'discover'] });
    },
  });
}

export function useUninstallGlobalMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.globalMcp.uninstall(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalMcpServers'] });
      queryClient.removeQueries({ queryKey: ['globalMcpServers', 'discover'] });
    },
  });
}

export function useDiscoverMcpEntries() {
  return useQuery({
    queryKey: ['globalMcpServers', 'discover'],
    queryFn: () => api.globalMcp.discover(),
    enabled: false, // Only fetch on demand
  });
}

export function useImportMcpEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      entry,
      backends,
    }: {
      entry: DiscoveredMcpVariant;
      backends: AgentBackendType[];
    }) => api.globalMcp.import(entry, backends),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['globalMcpServers'] });
      queryClient.removeQueries({ queryKey: ['globalMcpServers', 'discover'] });
    },
  });
}
