import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { startServer } from './server.ts';
import { getPaths } from './paths.ts';
import {
  readSettings, patchSettings,
  listPets, createPet, updatePet, deletePet,
  type Pet, type Settings,
} from './config.ts';
import {
  listProviders, createProvider, updateProvider, deleteProvider, getProviderInternal,
  type ProviderPublic,
} from './providers.ts';
import { Form, type FormField } from './cli-form.tsx';
import { createLLMClient, type ChatResponse } from './core/llm/index.ts';

// ─────────────────── boot: start server in same process ───────────────────

// startServer() resolves port: opts > $SOCIAL_AGENT_PORT > settings.json > default 8787
const { server, platform } = await startServer();
const SERVER_URL = `http://localhost:${server.port}`;

// ─────────────────── theme ───────────────────

/** Pink accent — replaces the previous cyan brand color throughout the TUI. */
const ACCENT = '#ff69b4';

/** Rainbow palette used by the main menu (per-item index). */
const RAINBOW = [
  '#ff5577',   // red
  '#ff9933',   // orange
  '#ffd700',   // yellow
  '#33dd66',   // green
  '#3399ff',   // blue
  '#aa55ff',   // violet
];

// ─────────────────── types ───────────────────

type Screen =
  | 'menu' | 'status'
  | 'providers' | 'provider-edit'
  | 'pets'      | 'pet-edit'
  | 'settings'  | 'settings-edit'
  | 'llm-test';

interface ScreenProps {
  goto: (s: Screen, id?: string | null) => void;
  editingId: string | null;
}

// ─────────────────── small components ───────────────────

function Avatar() {
  // Sitting cat — 9 rows, full body (head + ears + body + paws + tail).
  // Adapted from a common Joan Stark style sitting cat, normalized to box
  // drawing so glyph widths stay 1-cell across terminal fonts.
  //   row 1   /\___/\        ears + head dome
  //   row 2  (  o   o )      eyes
  //   row 3   ( =^= )         nose / whiskers
  //   row 4    \   /          jaw
  //   row 5   / o.o \         chest
  //   row 6  /       \        body
  //   row 7  | |   | |        front legs
  //   row 8   \___/_/         lower body
  //   row 9     U U           paws
  return (
    <Box flexDirection="column">
      <Text color={ACCENT}>{'   ╱╲___╱╲   '}</Text>
      <Text color={ACCENT}>{'  ╱       ╲  '}</Text>
      <Text color={ACCENT}>{' │ ◕     ◕ │ '}</Text>
      <Text color={ACCENT}>{' │    ω    │ '}</Text>
      <Text color={ACCENT}>{'  ╲ ─━━━─ ╱  '}</Text>
      <Text color={ACCENT}>{' ╱           ╲'}</Text>
      <Text color={ACCENT}>{'│  ╳     ╳  │'}</Text>
      <Text color={ACCENT}>{' ╲━━━━━━━━━╱ '}</Text>
      <Text color={ACCENT}>{'   ╲╱   ╲╱   '}</Text>
    </Box>
  );
}

function Header() {
  const paths = getPaths();
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Avatar />
      <Box flexDirection="column" marginLeft={2}>
        <Text>
          <Text bold color={ACCENT}>social-agent</Text>
          <Text dimColor> v0.0.1</Text>
        </Text>
        <Text>{SERVER_URL}</Text>
        <Text dimColor>{paths.home}</Text>
      </Box>
    </Box>
  );
}

function Footer({ hint }: { hint: string }) {
  return (
    <Box marginTop={1} borderStyle="single" borderColor="gray" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingTop={0}>
      <Text dimColor>{hint}</Text>
    </Box>
  );
}

interface MenuItem { key: Screen | 'quit'; label: string; disabled?: boolean }

function Menu({ items, onSelect }: { items: MenuItem[]; onSelect: (k: MenuItem['key']) => void }) {
  const enabledIdxs = items.map((it, i) => it.disabled ? -1 : i).filter(i => i >= 0);
  const [idx, setIdx] = useState(enabledIdxs[0] ?? 0);

  useInput((_input, key) => {
    if (key.upArrow) {
      const cur = enabledIdxs.indexOf(idx);
      const next = enabledIdxs[Math.max(0, cur - 1)];
      setIdx(next ?? idx);
    }
    if (key.downArrow) {
      const cur = enabledIdxs.indexOf(idx);
      const next = enabledIdxs[Math.min(enabledIdxs.length - 1, cur + 1)];
      setIdx(next ?? idx);
    }
    if (key.return) onSelect(items[idx].key);
  });

  return (
    <Box flexDirection="column">
      {items.map((it, i) => {
        const selected = i === idx;
        const color = it.disabled
          ? 'gray'
          : selected
            ? ACCENT
            : RAINBOW[i % RAINBOW.length];
        return (
          <Box key={it.key}>
            <Text color={color} bold={selected}>
              {selected ? '▶ ' : '  '}{it.label}
              {it.disabled ? ' (disabled)' : ''}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Box>
      <Box width={18}><Text dimColor>{k}</Text></Box>
      <Text>{v}</Text>
    </Box>
  );
}

// ─────────────────── screens ───────────────────

function MainMenu({ goto }: ScreenProps) {
  const { exit } = useApp();
  const items: MenuItem[] = [
    { key: 'status',    label: 'Status' },
    { key: 'providers', label: 'Providers' },
    { key: 'pets',      label: 'Pets' },
    { key: 'llm-test',  label: 'LLM Test' },
    { key: 'settings',  label: 'Settings' },
    { key: 'quit',      label: 'Quit' },
  ];

  const onSelect = (k: MenuItem['key']) => {
    if (k === 'quit') exit();
    else goto(k as Screen);
  };

  return (
    <Box flexDirection="column">
      <Menu items={items} onSelect={onSelect} />
      <Footer hint="↑↓ navigate · enter select · q to quit" />
    </Box>
  );
}

function StatusScreen({ goto }: ScreenProps) {
  const paths = getPaths();
  const [pets, setPets] = useState<Pet[]>([]);
  const [providerCount, setProviderCount] = useState<number | null>(null);

  useEffect(() => {
    listPets().then(setPets).catch(() => {});
    listProviders().then(ps => setProviderCount(ps.length)).catch(() => {});
  }, []);

  useInput((input, key) => { if (key.escape || input === 'q') goto('menu'); });

  return (
    <Box flexDirection="column">
      <Text bold underline>Status</Text>
      <Box marginTop={1} flexDirection="column">
        <Row k="server"         v={SERVER_URL} />
        <Row k="home"           v={paths.home} />
        <Row k="settings"       v={paths.settings} />
        <Row k="providers"      v={paths.providers} />
        <Row k="pets count"     v={String(pets.length)} />
        <Row k="provider count" v={String(providerCount ?? '…')} />
      </Box>
      <Footer hint="esc / q to back" />
    </Box>
  );
}

// ─── Providers ───

function ProvidersScreen({ goto }: ScreenProps) {
  const [items, setItems] = useState<ProviderPublic[]>([]);
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return listProviders()
      .then(ps => { setItems(ps); setIdx(i => Math.min(i, Math.max(0, ps.length - 1))); })
      .catch(e => setError(e?.message ?? String(e)));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useInput((input, key) => {
    if (key.escape || input === 'q') { goto('menu'); return; }
    if (key.upArrow)   setIdx(i => Math.max(0, i - 1));
    if (key.downArrow) setIdx(i => Math.min(items.length - 1, i + 1));
    if (input === 'a') goto('provider-edit', null);
    if (input === 'e' && items[idx]) goto('provider-edit', items[idx].id);
    if (input === 'd' && items[idx]) {
      const target = items[idx];
      deleteProvider(target.id)
        .then(refresh)
        .catch(e => setError(e?.message ?? String(e)));
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold underline>Providers ({items.length})</Text>
      {error && <Text color="red">{error}</Text>}
      <Box marginTop={1} flexDirection="column">
        {items.length === 0 && <Text dimColor>(empty — press 'a' to add)</Text>}
        {items.map((p, i) => {
          const sel = i === idx;
          return (
            <Box key={p.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={sel ? '#ff69b4' : undefined}>{sel ? '▶ ' : '  '}</Text>
                <Text bold={sel} color={sel ? '#ff69b4' : undefined}>{p.name}</Text>
                <Text dimColor> · {p.type}</Text>
              </Box>
              <Box marginLeft={2}><Text dimColor>apiKey:       {p.apiKeyMasked}</Text></Box>
              {p.baseUrl &&      <Box marginLeft={2}><Text dimColor>baseUrl:      {p.baseUrl}</Text></Box>}
              {p.defaultModel && <Box marginLeft={2}><Text dimColor>defaultModel: {p.defaultModel}</Text></Box>}
            </Box>
          );
        })}
      </Box>
      <Footer hint="↑↓ select · a add · e edit · d delete · q back" />
    </Box>
  );
}

function ProviderEditScreen({ goto, editingId }: ScreenProps) {
  const isEdit = !!editingId;
  const [initial, setInitial] = useState<ProviderPublic | null | 'loading'>(isEdit ? 'loading' : null);

  useEffect(() => {
    if (!isEdit) return;
    listProviders()
      .then(ps => setInitial(ps.find(x => x.id === editingId) ?? null))
      .catch(() => setInitial(null));
  }, [editingId, isEdit]);

  if (initial === 'loading') {
    return <Box flexDirection="column"><Text>loading…</Text></Box>;
  }
  if (isEdit && initial === null) {
    return <Box flexDirection="column"><Text color="red">provider not found</Text><Footer hint="esc to back" /></Box>;
  }

  const fields: FormField[] = [
    { kind: 'select', key: 'type', label: 'Type', options: [
      { value: 'openai-compat', label: 'openai-compat' },
      { value: 'anthropic',     label: 'anthropic' },
      { value: 'gemini',        label: 'gemini' },
    ]},
    { kind: 'text', key: 'name',         label: 'Name', placeholder: 'e.g. OpenRouter' },
    { kind: 'text', key: 'apiKey',       label: isEdit ? 'API Key (leave empty to keep existing)' : 'API Key', mask: true },
    { kind: 'text', key: 'baseUrl',      label: 'Base URL (required for openai-compat)', placeholder: 'https://openrouter.ai/api/v1' },
    { kind: 'text', key: 'defaultModel', label: 'Default Model (optional)' },
  ];

  const initialValues: Record<string, string> = isEdit && initial ? {
    type:         initial.type,
    name:         initial.name,
    apiKey:       '',           // never pre-fill — we only have the masked form
    baseUrl:      initial.baseUrl ?? '',
    defaultModel: initial.defaultModel ?? '',
  } : { type: 'openai-compat' };

  const onSubmit = async (vals: Record<string, string>) => {
    const name = vals.name.trim();
    if (!name) throw new Error('Name required');
    if (!isEdit && !vals.apiKey) throw new Error('API Key required');
    if (vals.type === 'openai-compat' && !vals.baseUrl.trim()) throw new Error('Base URL required for openai-compat');

    if (isEdit) {
      const partial: any = {
        type:         vals.type as ProviderPublic['type'],
        name,
        baseUrl:      vals.baseUrl.trim() || undefined,
        defaultModel: vals.defaultModel.trim() || undefined,
      };
      if (vals.apiKey) partial.apiKey = vals.apiKey;
      await updateProvider(editingId!, partial);
    } else {
      await createProvider({
        type:         vals.type as ProviderPublic['type'],
        name,
        apiKey:       vals.apiKey,
        baseUrl:      vals.baseUrl.trim() || undefined,
        defaultModel: vals.defaultModel.trim() || undefined,
      });
    }
    goto('providers');
  };

  return (
    <Box flexDirection="column">
      <Text bold underline>{isEdit ? 'Edit Provider' : 'Add Provider'}</Text>
      <Box marginTop={1}>
        <Form
          fields={fields}
          initial={initialValues}
          submitLabel={isEdit ? 'Update' : 'Create'}
          onSubmit={onSubmit}
          onCancel={() => goto('providers')}
        />
      </Box>
    </Box>
  );
}

// ─── Pets ───

function PetsScreen({ goto }: ScreenProps) {
  const [items, setItems] = useState<Pet[]>([]);
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return listPets()
      .then(ps => { setItems(ps); setIdx(i => Math.min(i, Math.max(0, ps.length - 1))); })
      .catch(e => setError(e?.message ?? String(e)));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useInput((input, key) => {
    if (key.escape || input === 'q') { goto('menu'); return; }
    if (key.upArrow)   setIdx(i => Math.max(0, i - 1));
    if (key.downArrow) setIdx(i => Math.min(items.length - 1, i + 1));
    if (input === 'a') goto('pet-edit', null);
    if (input === 'e' && items[idx]) goto('pet-edit', items[idx].id);
    if (input === 'd' && items[idx]) {
      const target = items[idx];
      deletePet(target.id).then(refresh).catch(e => setError(e?.message ?? String(e)));
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold underline>Pets ({items.length})</Text>
      {error && <Text color="red">{error}</Text>}
      <Box marginTop={1} flexDirection="column">
        {items.length === 0 && <Text dimColor>(empty — press 'a' to add)</Text>}
        {items.map((p, i) => {
          const sel = i === idx;
          return (
            <Box key={p.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={sel ? '#ff69b4' : undefined}>{sel ? '▶ ' : '  '}</Text>
                <Text bold={sel} color={sel ? '#ff69b4' : undefined}>{p.name}</Text>
                <Text dimColor>  ({p.id.slice(0, 8)}…)</Text>
              </Box>
              {p.persona && (
                <Box marginLeft={2}>
                  <Text dimColor>persona: <Text wrap="wrap">{p.persona.slice(0, 200)}{p.persona.length > 200 ? '…' : ''}</Text></Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>
      <Footer hint="↑↓ select · a add · e edit · d delete · q back" />
    </Box>
  );
}

function PetEditScreen({ goto, editingId }: ScreenProps) {
  const isEdit = !!editingId;
  const [initial, setInitial] = useState<Pet | null | 'loading'>(isEdit ? 'loading' : null);

  useEffect(() => {
    if (!isEdit) return;
    listPets()
      .then(ps => setInitial(ps.find(x => x.id === editingId) ?? null))
      .catch(() => setInitial(null));
  }, [editingId, isEdit]);

  if (initial === 'loading') return <Box flexDirection="column"><Text>loading…</Text></Box>;
  if (isEdit && initial === null) {
    return <Box flexDirection="column"><Text color="red">pet not found</Text><Footer hint="esc to back" /></Box>;
  }

  const fields: FormField[] = [
    { kind: 'text',     key: 'name',    label: 'Name' },
    { kind: 'textarea', key: 'persona', label: 'Persona (system prompt; multi-line OK)', placeholder: '猫娘 / 高知识 / 喜欢吐槽' },
  ];

  const initialValues: Record<string, string> = isEdit && initial ? {
    name:    initial.name,
    persona: initial.persona ?? '',
  } : {};

  const onSubmit = async (vals: Record<string, string>) => {
    const name = vals.name.trim();
    if (!name) throw new Error('Name required');
    const persona = vals.persona.trim() || undefined;
    if (isEdit) await updatePet(editingId!, { name, persona });
    else        await createPet({ name, persona });
    goto('pets');
  };

  return (
    <Box flexDirection="column">
      <Text bold underline>{isEdit ? 'Edit Pet' : 'Add Pet'}</Text>
      <Box marginTop={1}>
        <Form
          fields={fields}
          initial={initialValues}
          submitLabel={isEdit ? 'Update' : 'Create'}
          onSubmit={onSubmit}
          onCancel={() => goto('pets')}
        />
      </Box>
    </Box>
  );
}

// ─── Settings ───

function SettingsScreen({ goto }: ScreenProps) {
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => { readSettings().then(setS); }, []);
  useInput((input, key) => {
    if (key.escape || input === 'q') goto('menu');
    if (input === 'e') goto('settings-edit');
  });

  return (
    <Box flexDirection="column">
      <Text bold underline>Settings</Text>
      {!s ? <Text>loading…</Text> : (
        <Box marginTop={1} flexDirection="column">
          <Row k="port"              v={String(s.port)} />
          <Row k="logLevel"          v={s.logLevel} />
          <Row k="defaultProviderId" v={s.defaultProviderId ?? '(unset)'} />
          <Row k="defaultModel"      v={s.defaultModel ?? '(unset)'} />
        </Box>
      )}
      <Footer hint="e edit · q back" />
    </Box>
  );
}

function SettingsEditScreen({ goto }: ScreenProps) {
  const [s, setS]                 = useState<Settings | null>(null);
  const [providers, setProviders] = useState<ProviderPublic[]>([]);

  useEffect(() => {
    readSettings().then(setS);
    listProviders().then(setProviders).catch(() => {});
  }, []);

  if (!s) return <Box><Text>loading…</Text></Box>;

  const fields: FormField[] = [
    { kind: 'text',   key: 'port',     label: 'Port (restart server to apply)' },
    { kind: 'select', key: 'logLevel', label: 'Log Level', options: [
      { value: 'debug', label: 'debug' },
      { value: 'info',  label: 'info' },
      { value: 'warn',  label: 'warn' },
      { value: 'error', label: 'error' },
    ]},
    { kind: 'select', key: 'defaultProviderId', label: 'Default Provider', options: [
      { value: '', label: '(unset)' },
      ...providers.map(p => ({ value: p.id, label: `${p.name} (${p.type})` })),
    ]},
    { kind: 'text', key: 'defaultModel', label: 'Default Model (optional)' },
  ];

  const initial: Record<string, string> = {
    port:              String(s.port),
    logLevel:          s.logLevel,
    defaultProviderId: s.defaultProviderId ?? '',
    defaultModel:      s.defaultModel ?? '',
  };

  const onSubmit = async (vals: Record<string, string>) => {
    const port = Number(vals.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error('port must be 1–65535');
    }
    if (!['debug', 'info', 'warn', 'error'].includes(vals.logLevel)) {
      throw new Error('logLevel must be debug/info/warn/error');
    }
    await patchSettings({
      port,
      logLevel:          vals.logLevel as Settings['logLevel'],
      defaultProviderId: vals.defaultProviderId || undefined,
      defaultModel:      vals.defaultModel.trim() || undefined,
    });
    goto('settings');
  };

  return (
    <Box flexDirection="column">
      <Text bold underline>Edit Settings</Text>
      <Box marginTop={1}>
        <Form
          fields={fields}
          initial={initial}
          submitLabel="Save"
          onSubmit={onSubmit}
          onCancel={() => goto('settings')}
        />
      </Box>
    </Box>
  );
}

// ─── LLM Test ───

function LLMTestScreen({ goto }: ScreenProps) {
  const [providers, setProviders]   = useState<ProviderPublic[]>([]);
  const [phase, setPhase]           = useState<'form' | 'running' | 'result'>('form');
  const [result, setResult]         = useState<ChatResponse | null>(null);
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  useEffect(() => { listProviders().then(setProviders).catch(() => {}); }, []);

  useInput((input, key) => {
    if (phase === 'running') return;
    if (phase === 'result') {
      if (key.escape || input === 'q') goto('menu');
      if (input === 'r') { setResult(null); setErrorMsg(null); setPhase('form'); }
    }
  });

  if (providers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold underline>LLM Test</Text>
        <Box marginTop={1}><Text color="yellow">No providers configured. Add one in Providers screen first.</Text></Box>
        <Footer hint="esc / q to back" />
      </Box>
    );
  }

  if (phase === 'running') {
    return (
      <Box flexDirection="column">
        <Text bold underline>LLM Test</Text>
        <Box marginTop={1}><Text color="yellow">calling LLM…</Text></Box>
      </Box>
    );
  }

  if (phase === 'result' && result) {
    return (
      <Box flexDirection="column">
        <Text bold underline>LLM Test — Result</Text>
        <Box marginTop={1} flexDirection="column">
          <Row k="model"         v={result.model} />
          <Row k="elapsed"       v={`${result.elapsedMs}ms`} />
          <Row k="input tokens"  v={String(result.inputTokens)} />
          <Row k="output tokens" v={String(result.outputTokens)} />
          <Row k="finish"        v={result.finishReason} />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>response:</Text>
          <Text wrap="wrap">{result.content}</Text>
        </Box>
        <Footer hint="r retry · q back" />
      </Box>
    );
  }

  if (phase === 'result' && errorMsg) {
    return (
      <Box flexDirection="column">
        <Text bold underline>LLM Test — Error</Text>
        <Box marginTop={1}><Text color="red" wrap="wrap">{errorMsg}</Text></Box>
        <Footer hint="r retry · q back" />
      </Box>
    );
  }

  // phase === 'form'
  const fields: FormField[] = [
    { kind: 'select', key: 'providerId', label: 'Provider',
      options: providers.map(p => ({ value: p.id, label: `${p.name} (${p.type})` })) },
    { kind: 'text',     key: 'model',  label: 'Model',  placeholder: 'claude-3-5-haiku-latest' },
    { kind: 'textarea', key: 'prompt', label: 'Prompt' },
  ];

  const first = providers[0];
  const initial: Record<string, string> = {
    providerId: first.id,
    model:      first.defaultModel ?? '',
    prompt:     'hi, in one sentence describe yourself',
  };

  const onSubmit = async (vals: Record<string, string>) => {
    if (!vals.model)  throw new Error('model required');
    if (!vals.prompt) throw new Error('prompt required');
    const provider = await getProviderInternal(vals.providerId);
    if (!provider) throw new Error('provider not found');
    setPhase('running');
    try {
      const client = createLLMClient(platform, provider);
      const r = await client.chat({
        messages:  [{ role: 'user', content: vals.prompt }],
        model:     vals.model,
        maxTokens: 256,
      });
      setResult(r); setErrorMsg(null); setPhase('result');
    } catch (e: any) {
      setErrorMsg(e?.message ?? String(e));
      setResult(null);
      setPhase('result');
    }
  };

  return (
    <Box flexDirection="column">
      <Text bold underline>LLM Test</Text>
      <Box marginTop={1}>
        <Form
          fields={fields}
          initial={initial}
          submitLabel="Send"
          onSubmit={onSubmit}
          onCancel={() => goto('menu')}
        />
      </Box>
    </Box>
  );
}

// ─────────────────── App ───────────────────

function App() {
  const [screen, setScreen]       = useState<Screen>('menu');
  const [editingId, setEditingId] = useState<string | null>(null);

  const goto = useCallback((s: Screen, id: string | null = null) => {
    setEditingId(id);
    setScreen(s);
  }, []);

  const { exit } = useApp();
  useInput((input, key) => {
    if (screen === 'menu' && (input === 'q' || (key.ctrl && input === 'c'))) exit();
  });

  const props: ScreenProps = { goto, editingId };

  return (
    <Box flexDirection="column" padding={1}>
      <Header />
      {screen === 'menu'          && <MainMenu          {...props} />}
      {screen === 'status'        && <StatusScreen      {...props} />}
      {screen === 'providers'     && <ProvidersScreen   {...props} />}
      {screen === 'provider-edit' && <ProviderEditScreen {...props} />}
      {screen === 'pets'          && <PetsScreen        {...props} />}
      {screen === 'pet-edit'      && <PetEditScreen     {...props} />}
      {screen === 'settings'      && <SettingsScreen    {...props} />}
      {screen === 'settings-edit' && <SettingsEditScreen {...props} />}
      {screen === 'llm-test'      && <LLMTestScreen     {...props} />}
    </Box>
  );
}

const { waitUntilExit } = render(<App />);
await waitUntilExit();
server.stop();
process.exit(0);
