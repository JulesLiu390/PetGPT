import React, { useState, useEffect, useCallback } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { startServer } from './server.ts';
import { getPaths } from './paths.ts';
import { readSettings, listPets, type Pet } from './config.ts';
import {
  isUnlocked, isInitialized, unlock, lock,
  listProviders, type ProviderPublic,
} from './providers.ts';

// ─────────────────── boot: start server in same process ───────────────────

const settings = await readSettings();
const { server } = await startServer({ port: settings.port });
const SERVER_URL = `http://localhost:${server.port}`;

// ─────────────────── types ───────────────────

type Screen = 'menu' | 'status' | 'unlock' | 'providers' | 'pets' | 'settings';

interface ScreenProps {
  goto: (s: Screen) => void;
  unlocked: boolean;
  refreshUnlocked: () => void;
}

// ─────────────────── small components ───────────────────

function Header({ unlocked }: { unlocked: boolean }) {
  const paths = getPaths();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="cyan">social-agent</Text>
        <Text dimColor> v0.0.1 · </Text>
        <Text>{SERVER_URL}</Text>
        <Text>  </Text>
        <Text color={unlocked ? 'green' : 'yellow'}>
          {unlocked ? '🔓 unlocked' : '🔒 locked'}
        </Text>
      </Box>
      <Text dimColor>{paths.home}</Text>
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

interface MenuItem { key: Screen | 'lock' | 'quit'; label: string; disabled?: boolean }

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
      {items.map((it, i) => (
        <Box key={it.key}>
          <Text color={i === idx ? 'cyan' : it.disabled ? 'gray' : undefined} bold={i === idx}>
            {i === idx ? '▶ ' : '  '}{it.label}
            {it.disabled ? ' (locked)' : ''}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function PasswordDots({ length }: { length: number }) {
  return (
    <Box>
      <Text>{'•'.repeat(length)}</Text>
      <Text color="cyan">▌</Text>
    </Box>
  );
}

// ─────────────────── screens ───────────────────

function MainMenu({ goto, unlocked, refreshUnlocked }: ScreenProps) {
  const { exit } = useApp();
  const items: MenuItem[] = [
    { key: 'status',    label: 'Status' },
    unlocked
      ? { key: 'lock',  label: 'Lock' }
      : { key: 'unlock', label: isInitialized() ? 'Unlock providers store' : 'Initialize providers store' },
    { key: 'providers', label: 'Providers',  disabled: !unlocked },
    { key: 'pets',      label: 'Pets' },
    { key: 'settings',  label: 'Settings' },
    { key: 'quit',      label: 'Quit' },
  ];

  const onSelect = (k: MenuItem['key']) => {
    if (k === 'quit') exit();
    else if (k === 'lock') { lock(); refreshUnlocked(); }
    else goto(k as Screen);
  };

  return (
    <Box flexDirection="column">
      <Menu items={items} onSelect={onSelect} />
      <Footer hint="↑↓ navigate · enter select · q to quit" />
    </Box>
  );
}

function StatusScreen({ goto, unlocked }: ScreenProps) {
  const paths = getPaths();
  const [pets, setPets] = useState<Pet[]>([]);
  const [providerCount, setProviderCount] = useState<number | null>(null);

  useEffect(() => {
    listPets().then(setPets).catch(() => {});
    if (unlocked) listProviders().then(ps => setProviderCount(ps.length)).catch(() => {});
  }, [unlocked]);

  useInput((input, key) => { if (key.escape || input === 'q') goto('menu'); });

  return (
    <Box flexDirection="column">
      <Text bold underline>Status</Text>
      <Box marginTop={1} flexDirection="column">
        <Row k="server"        v={SERVER_URL} />
        <Row k="home"          v={paths.home} />
        <Row k="settings"      v={paths.settings} />
        <Row k="providers.enc" v={`${paths.providers}  ${unlocked ? '(unlocked)' : '(locked)'}`} />
        <Row k="pets count"    v={String(pets.length)} />
        <Row k="provider count" v={unlocked ? String(providerCount ?? '…') : '— (unlock first)'} />
      </Box>
      <Footer hint="esc / q to back" />
    </Box>
  );
}

function UnlockScreen({ goto, refreshUnlocked }: ScreenProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const initialized = isInitialized();

  useInput((input, key) => {
    if (pending) return;
    if (key.escape) goto('menu');
    else if (key.return) {
      if (!value || value.length < 4) { setError('password too short (min 4 chars)'); return; }
      setError(null); setPending(true);
      unlock(value)
        .then(() => { refreshUnlocked(); goto('menu'); })
        .catch((e) => { setError(e?.message ?? String(e)); setPending(false); });
    }
    else if (key.backspace || key.delete) setValue(v => v.slice(0, -1));
    else if (input && !key.ctrl && !key.meta && input.length === 1) setValue(v => v + input);
  });

  return (
    <Box flexDirection="column">
      <Text bold underline>{initialized ? 'Unlock providers store' : 'Initialize providers store'}</Text>
      <Text dimColor>
        {initialized
          ? 'enter your master password'
          : 'create a master password (≥ 4 chars). this will encrypt providers.enc.'}
      </Text>
      <Box marginTop={1}>
        <Text>password: </Text>
        <PasswordDots length={value.length} />
      </Box>
      {error && <Box marginTop={1}><Text color="red">{error}</Text></Box>}
      {pending && <Box marginTop={1}><Text color="yellow">deriving key…</Text></Box>}
      <Footer hint="enter to submit · esc to cancel" />
    </Box>
  );
}

function ProvidersScreen({ goto }: ScreenProps) {
  const [items, setItems] = useState<ProviderPublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProviders()
      .then(ps => { setItems(ps); setLoading(false); })
      .catch(e => { setError(e?.message ?? String(e)); setLoading(false); });
  }, []);

  useInput((input, key) => { if (key.escape || input === 'q') goto('menu'); });

  return (
    <Box flexDirection="column">
      <Text bold underline>Providers ({items.length})</Text>
      {loading && <Text>loading…</Text>}
      {error && <Text color="red">{error}</Text>}
      <Box marginTop={1} flexDirection="column">
        {items.map(p => (
          <Box key={p.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text bold>{p.name}</Text>
              <Text dimColor> · {p.type}</Text>
            </Box>
            <Text dimColor>  apiKey:       <Text>{p.apiKeyMasked}</Text></Text>
            {p.baseUrl      && <Text dimColor>  baseUrl:      <Text>{p.baseUrl}</Text></Text>}
            {p.defaultModel && <Text dimColor>  defaultModel: <Text>{p.defaultModel}</Text></Text>}
          </Box>
        ))}
        {!loading && items.length === 0 && <Text dimColor>(empty — add via dashboard or curl POST /api/providers)</Text>}
      </Box>
      <Footer hint="esc / q to back · use dashboard or REST to add/edit" />
    </Box>
  );
}

function PetsScreen({ goto }: ScreenProps) {
  const [items, setItems] = useState<Pet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listPets().then(ps => { setItems(ps); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useInput((input, key) => { if (key.escape || input === 'q') goto('menu'); });

  return (
    <Box flexDirection="column">
      <Text bold underline>Pets ({items.length})</Text>
      {loading && <Text>loading…</Text>}
      <Box marginTop={1} flexDirection="column">
        {items.map(p => (
          <Box key={p.id} flexDirection="column" marginBottom={1}>
            <Text bold>{p.name}</Text>
            <Text dimColor>  id: {p.id}</Text>
            {p.persona && <Text dimColor>  persona: <Text wrap="wrap">{p.persona.slice(0, 200)}{p.persona.length > 200 ? '…' : ''}</Text></Text>}
          </Box>
        ))}
        {!loading && items.length === 0 && <Text dimColor>(empty — add via dashboard or REST)</Text>}
      </Box>
      <Footer hint="esc / q to back" />
    </Box>
  );
}

function SettingsScreen({ goto }: ScreenProps) {
  const [s, setS] = useState<Awaited<ReturnType<typeof readSettings>> | null>(null);
  useEffect(() => { readSettings().then(setS); }, []);
  useInput((input, key) => { if (key.escape || input === 'q') goto('menu'); });

  return (
    <Box flexDirection="column">
      <Text bold underline>Settings</Text>
      {!s ? <Text>loading…</Text> : (
        <Box marginTop={1} flexDirection="column">
          <Row k="port"     v={String(s.port)} />
          <Row k="logLevel" v={s.logLevel} />
          {s.defaultProviderId && <Row k="defaultProviderId" v={s.defaultProviderId} />}
          {s.defaultModel      && <Row k="defaultModel"      v={s.defaultModel} />}
        </Box>
      )}
      <Footer hint="esc / q to back · edit via dashboard or PATCH /api/settings" />
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

// ─────────────────── App ───────────────────

function App() {
  const [screen, setScreen] = useState<Screen>('menu');
  const [unlocked, setUnlocked] = useState<boolean>(isUnlocked());
  const refreshUnlocked = useCallback(() => setUnlocked(isUnlocked()), []);

  const { exit } = useApp();
  useInput((input, key) => {
    if (screen === 'menu' && (input === 'q' || (key.ctrl && input === 'c'))) exit();
  });

  const props: ScreenProps = { goto: setScreen, unlocked, refreshUnlocked };

  return (
    <Box flexDirection="column" padding={1}>
      <Header unlocked={unlocked} />
      {screen === 'menu'      && <MainMenu      {...props} />}
      {screen === 'status'    && <StatusScreen  {...props} />}
      {screen === 'unlock'    && <UnlockScreen  {...props} />}
      {screen === 'providers' && <ProvidersScreen {...props} />}
      {screen === 'pets'      && <PetsScreen    {...props} />}
      {screen === 'settings'  && <SettingsScreen {...props} />}
    </Box>
  );
}

// startServer() doesn't log when invoked as a function (only the `import.meta.main`
// path logs), so Ink's render won't be corrupted by stale stdout.
const { waitUntilExit } = render(<App />);
await waitUntilExit();
server.stop();
process.exit(0);
