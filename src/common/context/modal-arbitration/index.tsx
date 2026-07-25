import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Request = { id: string; priority: number; sequence: number };

const ModalArbitrationContext = createContext<{
  ownerId: string | null;
  register: (id: string, priority: number) => () => void;
} | null>(null);
const ModalArbitrationScopeContext = createContext(false);

export function ModalArbitrationProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const sequenceRef = useRef(0);
  const ownerId = useMemo(
    () =>
      requests.reduce<Request | null>((owner, request) => {
        if (!owner) return request;
        if (request.priority !== owner.priority) {
          return request.priority > owner.priority ? request : owner;
        }
        return request.sequence > owner.sequence ? request : owner;
      }, null)?.id ?? null,
    [requests],
  );
  const register = useCallback((id: string, priority: number) => {
    const request = { id, priority, sequence: ++sequenceRef.current };
    setRequests((current) => [...current.filter((item) => item.id !== id), request]);
    return () => setRequests((current) => current.filter((item) => item.id !== id));
  }, []);
  const value = useMemo(() => ({ ownerId, register }), [ownerId, register]);

  return (
    <ModalArbitrationContext.Provider value={value}>
      {children}
    </ModalArbitrationContext.Provider>
  );
}

export function useModalArbitration(active: boolean, priority = 50) {
  const id = useId();
  const context = useContext(ModalArbitrationContext);
  const ownedScope = useContext(ModalArbitrationScopeContext);
  const register = context?.register;

  useLayoutEffect(() => {
    if (!active || !register || ownedScope) return;
    return register(id, priority);
  }, [active, id, ownedScope, priority, register]);

  return active && (ownedScope || !context || context.ownerId === id);
}

export function ModalArbitrationScope({ children }: { children: ReactNode }) {
  return (
    <ModalArbitrationScopeContext.Provider value>
      {children}
    </ModalArbitrationScopeContext.Provider>
  );
}
