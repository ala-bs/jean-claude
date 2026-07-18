import { ChevronDown, ChevronRight, RefreshCw, Sparkles } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { PreferenceEvidenceRecord, PreferenceMemoryHistoryEntry } from '@shared/preference-memory-types';
import { api } from '@/lib/api';
import { Button } from '@/common/ui/button';
import { MarkdownContent } from '@/features/agent/ui-markdown-content';
import { Select } from '@/common/ui/select';
import { useActiveProjects } from '@/hooks/use-projects';
import { useState } from 'react';

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'Never';
}

function EvidenceRow({ record }: { record: PreferenceEvidenceRecord }) {
  const comment = record.comment.body.replaceAll('\n', ' ');
  return (
    <div className="border-glass-border border-b py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-wider">
        <span className="text-acc-ink">{record.source === 'pr-file-comment' ? 'PR comment' : 'Task review'}</span>
        <span className="text-ink-4">{formatDate(record.createdAt)}</span>
      </div>
      <p className="text-ink-2 mt-1 truncate text-xs" title={record.comment.body}>{comment}</p>
      {record.comment.filePath && <span className="text-ink-4 mt-1 block truncate font-mono text-[10px]">{record.comment.filePath}</span>}
    </div>
  );
}

function HistoryRow({ entry }: { entry: PreferenceMemoryHistoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-glass-border border-b last:border-b-0">
      <button className="text-ink-2 flex w-full items-center gap-2 py-3 text-left text-xs" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="flex-1">{formatDate(entry.createdAt)}</span>
        <span className="text-ink-4">{entry.backend} / {entry.model}</span>
      </button>
      {expanded && <div className="bg-bg-2 mb-3 rounded-md p-3"><MarkdownContent content={entry.document.content || '_No preferences recorded._'} /></div>}
    </div>
  );
}

export function PreferenceMemoryDashboard() {
  const { data: projects = [] } = useActiveProjects();
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(0);
  const [raw, setRaw] = useState(false);
  const queryClient = useQueryClient();
  const selectedProjectId = projectId || projects[0]?.id || '';
  const dashboardQuery = useQuery({
    queryKey: ['preference-memory-dashboard', selectedProjectId, page],
    queryFn: () => api.preferenceMemory.getDashboard({ projectId: selectedProjectId, page }),
    enabled: Boolean(selectedProjectId),
  });
  const consolidate = useMutation({
    mutationFn: () => api.preferenceMemory.consolidate(selectedProjectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preference-memory-dashboard', selectedProjectId] }),
  });
  const dashboard = dashboardQuery.data;
  const error = dashboardQuery.error ?? consolidate.error;

  if (projects.length === 0) return <p className="text-ink-3 mt-4 text-xs">Add project to inspect agent memory.</p>;
  return (
    <div className="border-glass-border bg-bg-1 mt-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="text-ink-1 text-sm font-medium">Memory observatory</div><p className="text-ink-3 mt-1 text-xs">Stored evidence and computed preferences.</p></div>
        <div className="flex items-center gap-2">
          <Select value={selectedProjectId} options={projects.map((project) => ({ value: project.id, label: project.name }))} onChange={(value) => { setProjectId(value); setPage(0); }} />
          <Button size="sm" variant="ghost" onClick={() => void dashboardQuery.refetch()} aria-label="Refresh memory"><RefreshCw size={14} /></Button>
          <Button size="sm" variant="secondary" disabled={consolidate.isPending} onClick={() => consolidate.mutate()}><Sparkles size={14} /> Consolidate</Button>
        </div>
      </div>
      {!dashboard && dashboardQuery.isLoading && <p className="text-ink-3 py-8 text-center text-xs">Loading memory...</p>}
      {dashboard && (
        <>
          {error && <p className="text-danger mt-3 text-xs">Memory operation failed: {error instanceof Error ? error.message : 'Unknown error'}</p>}
          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            {[
              ['Evidence', dashboard.evidence.total],
              ['Task reviews', dashboard.evidence.bySource['task-review-comment']],
              ['PR comments', dashboard.evidence.bySource['pr-file-comment']],
              ['Pending bytes', dashboard.state.pendingBytes],
            ].map(([label, value]) => <div className="bg-bg-2 rounded-md p-3" key={label}><div className="text-ink-4 text-[10px] uppercase tracking-wider">{label}</div><div className="text-ink-1 mt-1 text-lg font-semibold">{value}</div></div>)}
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <section><div className="flex items-center justify-between"><h3 className="text-ink-1 text-xs font-semibold uppercase tracking-wider">Computed preferences</h3><button className="text-acc-ink text-[10px]" onClick={() => setRaw((value) => !value)}>{raw ? 'Rendered' : 'Raw'}</button></div><div className="bg-bg-2 mt-2 max-h-72 overflow-auto rounded-md p-3 text-xs">{raw ? <pre className="whitespace-pre-wrap">{dashboard.preferences.content || 'No preferences yet.'}</pre> : <MarkdownContent content={dashboard.preferences.content || '_No preferences computed yet._'} />}</div><p className="text-ink-4 mt-1 text-[10px]">Updated {formatDate(dashboard.preferences.updatedAt)}</p></section>
            <section><h3 className="text-ink-1 text-xs font-semibold uppercase tracking-wider">Evidence</h3><div className="bg-bg-2 mt-2 max-h-72 overflow-auto rounded-md px-3">{dashboard.evidence.records.length ? dashboard.evidence.records.map((record) => <EvidenceRow key={record.id} record={record} />) : <p className="text-ink-3 py-8 text-center text-xs">Enable capture, then leave review comments.</p>}</div><div className="mt-2 flex items-center justify-between"><button className="text-acc-ink text-xs" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><span className="text-ink-4 text-[10px]">Page {page + 1} of {Math.max(1, Math.ceil(dashboard.evidence.total / dashboard.evidence.pageSize))}</span><button className="text-acc-ink text-xs" disabled={(page + 1) * dashboard.evidence.pageSize >= dashboard.evidence.total} onClick={() => setPage((value) => value + 1)}>Next</button></div></section>
          </div>
          <section className="mt-4"><h3 className="text-ink-1 text-xs font-semibold uppercase tracking-wider">Consolidation history</h3><div className="bg-bg-2 mt-2 rounded-md px-3">{dashboard.history.length ? dashboard.history.map((entry) => <HistoryRow key={entry.id} entry={entry} />) : <p className="text-ink-3 py-5 text-xs">No consolidation runs yet. Last run: {formatDate(dashboard.state.lastConsolidatedAt)}.</p>}</div></section>
        </>
      )}
    </div>
  );
}
