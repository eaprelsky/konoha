import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditAgentModal } from '../components/agents/EditAgentModal';
import { api } from '../api/client';
import type { Agent } from '../api/types';

vi.mock('../api/client', () => ({
  api: {
    agents: {
      get: vi.fn(),
      update: vi.fn(),
      systemTemplate: vi.fn(),
      generateAvatar: vi.fn(),
      generateAvatarImg2Img: vi.fn(),
      uploadAvatar: vi.fn(),
    },
    skills: {
      list: vi.fn(),
    },
  },
}));

const codexAgent = {
  id: 'shikadai',
  name: 'Architecture reviewer',
  display_alias: 'Shikadai',
  status: 'online',
  runtime: 'codex',
  fallback_runtime: 'claude',
  model: 'codex:gpt-5.5',
  reasoning_effort: 'high',
  system_prompt: 'Initial prompt',
  capabilities: ['review'],
  gender: 'male',
} satisfies Agent;

describe('EditAgentModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.agents.get as any).mockResolvedValue(codexAgent);
    (api.agents.update as any).mockResolvedValue(codexAgent);
    (api.agents.systemTemplate as any).mockResolvedValue({ template: 'Managed system prompt' });
    (api.skills.list as any).mockResolvedValue([]);
  });

  it('sends only system_prompt when prompt is the only edited field', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<EditAgentModal agent={codexAgent} onClose={onClose} onSaved={onSaved} />);

    await waitFor(() => expect(api.agents.get).toHaveBeenCalledWith('shikadai'));
    await waitFor(() => {
      const prompt = [...container.querySelectorAll('textarea')]
        .find(textarea => textarea.value === 'Initial prompt');
      expect(prompt).toBeDefined();
    });

    const prompt = [...container.querySelectorAll('textarea')]
      .find(textarea => textarea.value === 'Initial prompt')!;
    fireEvent.change(prompt, { target: { value: 'Updated prompt only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.agents.update).toHaveBeenCalledTimes(1));
    expect(api.agents.update).toHaveBeenCalledWith('shikadai', {
      system_prompt: 'Updated prompt only',
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
