/**
 * BrandingContext — provides white-label config to all components (closes #298)
 * Fetched once at startup from GET /api/branding.
 */

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

export interface BrandingTheme {
  primary_color?: string;
  accent_color?: string;
  logo_url?: string;
}

export interface Branding {
  product_name: string;
  assistant_agent_id: string;
  agent_display_names: Record<string, string>;
  theme: BrandingTheme;
}

const DEFAULTS: Branding = {
  product_name: 'Konoha WE',
  assistant_agent_id: '',
  agent_display_names: {},
  theme: { primary_color: '#6366f1', accent_color: '#f59e0b' },
};

const BrandingCtx = createContext<Branding>(DEFAULTS);

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<Branding>(DEFAULTS);

  useEffect(() => {
    fetch('/api/branding')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) setBranding({ ...DEFAULTS, ...data, theme: { ...DEFAULTS.theme, ...(data.theme ?? {}) } });
      })
      .catch(() => {});
  }, []);

  return <BrandingCtx.Provider value={branding}>{children}</BrandingCtx.Provider>;
}

export function useBranding(): Branding {
  return useContext(BrandingCtx);
}
