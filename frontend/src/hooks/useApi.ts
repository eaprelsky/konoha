import { useState, useEffect, useCallback, useRef } from 'react';

export type ApiState<T> = { data: T | null; loading: boolean; error: string | null };

export function useApi<T>(fetcher: () => Promise<T>, deps: unknown[] = []): ApiState<T> & { refetch: () => void } {
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(() => {
    setState(s => ({ ...s, loading: true, error: null }));
    fetcherRef.current()
      .then(data => setState({ data, loading: false, error: null }))
      .catch(e => setState({ data: null, loading: false, error: e.message }));
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { run(); }, [run]);

  return { ...state, refetch: run };
}

export function useInterval(callback: () => void, ms: number) {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => {
    const id = setInterval(() => cbRef.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
