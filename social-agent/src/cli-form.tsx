import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

/**
 * Minimal Ink form primitive used by the TUI editor screens.
 *
 * Keymap:
 *   tab / shift-tab     → next / prev focusable
 *   ↓ / ↑               → next / prev focusable (text fields)
 *   ←/→ or ↑↓ on select → switch option
 *   enter on text       → next focusable
 *   enter on textarea   → insert \n
 *   enter on Submit     → onSubmit(values)
 *   enter on Cancel     → onCancel()
 *   esc anywhere        → onCancel()
 *
 * Trade-offs (intentional, v1):
 *   - no in-line cursor positioning; backspace at end only
 *   - no clipboard / no kill-line / no word delete
 */

export type FormField =
  | { kind: 'text';     key: string; label: string; placeholder?: string; mask?: boolean }
  | { kind: 'textarea'; key: string; label: string; placeholder?: string }
  | { kind: 'select';   key: string; label: string; options: { value: string; label?: string }[] };

export interface FormProps {
  fields: FormField[];
  initial?: Record<string, string>;
  submitLabel?: string;          // default 'Save'
  cancelLabel?: string;          // default 'Cancel'
  onSubmit: (values: Record<string, string>) => Promise<void> | void;
  onCancel: () => void;
}

export function Form({ fields, initial, submitLabel = 'Save', cancelLabel = 'Cancel', onSubmit, onCancel }: FormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const f of fields) {
      m[f.key] = initial?.[f.key] ?? (f.kind === 'select' ? (f.options[0]?.value ?? '') : '');
    }
    return m;
  });
  const [focusIdx, setFocusIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = fields.length + 2;     // Submit / Cancel are last two focusables
  const submitIdx = fields.length;
  const cancelIdx = fields.length + 1;

  const moveFocus = (delta: number) =>
    setFocusIdx(i => ((i + delta) % total + total) % total);

  const setField = (key: string, fn: (v: string) => string) =>
    setValues(v => ({ ...v, [key]: fn(v[key] ?? '') }));

  useInput((input, key) => {
    if (submitting) return;
    if (key.escape) { onCancel(); return; }

    if (key.tab && key.shift) { moveFocus(-1); return; }
    if (key.tab)              { moveFocus(+1); return; }

    // ── Submit button focused ──
    if (focusIdx === submitIdx) {
      if (key.return) {
        setError(null);
        setSubmitting(true);
        Promise.resolve(onSubmit(values))
          .catch(e => { setError(e?.message ?? String(e)); setSubmitting(false); })
          .then(() => { /* no-op on success — caller unmounts */ });
        return;
      }
      if (key.upArrow)    moveFocus(-1);
      if (key.rightArrow) moveFocus(+1);
      if (key.downArrow)  moveFocus(+1);
      if (key.leftArrow)  moveFocus(-1);
      return;
    }

    // ── Cancel button focused ──
    if (focusIdx === cancelIdx) {
      if (key.return)     { onCancel(); return; }
      if (key.upArrow)    moveFocus(-1);    // back to last field
      if (key.leftArrow)  moveFocus(-1);    // back to Submit
      if (key.downArrow)  moveFocus(-1);    // wrap unlikely
      return;
    }

    // ── Field focused ──
    const field = fields[focusIdx];

    if (field.kind === 'select') {
      const opts = field.options;
      const cur = Math.max(0, opts.findIndex(o => o.value === values[field.key]));
      if (key.upArrow || key.leftArrow) {
        const next = opts[Math.max(0, cur - 1)];
        setValues(v => ({ ...v, [field.key]: next.value }));
        return;
      }
      if (key.downArrow || key.rightArrow) {
        const next = opts[Math.min(opts.length - 1, cur + 1)];
        setValues(v => ({ ...v, [field.key]: next.value }));
        return;
      }
      if (key.return) { moveFocus(+1); return; }
      // Letter shortcut: jump to first option starting with that letter
      if (input && input.length === 1 && /[a-zA-Z0-9]/.test(input)) {
        const idx = opts.findIndex(o => (o.label ?? o.value).toLowerCase().startsWith(input.toLowerCase()));
        if (idx >= 0) setValues(v => ({ ...v, [field.key]: opts[idx].value }));
      }
      return;
    }

    // text / textarea
    if (key.upArrow)   { moveFocus(-1); return; }
    if (key.downArrow) { moveFocus(+1); return; }
    if (key.backspace || key.delete) { setField(field.key, v => v.slice(0, -1)); return; }
    if (key.return) {
      if (field.kind === 'textarea') { setField(field.key, v => v + '\n'); return; }
      moveFocus(+1);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setField(field.key, v => v + input);
    }
  });

  return (
    <Box flexDirection="column">
      {fields.map((f, i) => (
        <FieldRender
          key={f.key}
          field={f}
          value={values[f.key] ?? ''}
          focused={i === focusIdx}
        />
      ))}
      <Box marginTop={1}>
        <ButtonText label={submitting ? `${submitLabel}…` : submitLabel}
                    color="cyan"
                    focused={focusIdx === submitIdx} />
        <Box marginLeft={2}>
          <ButtonText label={cancelLabel} color="red" focused={focusIdx === cancelIdx} />
        </Box>
      </Box>
      {error && <Box marginTop={1}><Text color="red">{error}</Text></Box>}
      <Box marginTop={1} borderStyle="single" borderColor="gray" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
        <Text dimColor>tab/↓ next · shift-tab/↑ prev · enter advance/submit · esc cancel</Text>
      </Box>
    </Box>
  );
}

function FieldRender({ field, value, focused }: { field: FormField; value: string; focused: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={focused ? 'cyan' : undefined} bold={focused} dimColor={!focused}>
        {focused ? '▶ ' : '  '}{field.label}
      </Text>
      <Box marginLeft={2}>
        {field.kind === 'text'     && <TextLine value={value} focused={focused} placeholder={field.placeholder} mask={!!field.mask} />}
        {field.kind === 'textarea' && <TextAreaLines value={value} focused={focused} placeholder={field.placeholder} />}
        {field.kind === 'select'   && <SelectRow options={field.options} value={value} focused={focused} />}
      </Box>
    </Box>
  );
}

function TextLine({ value, focused, placeholder, mask }: { value: string; focused: boolean; placeholder?: string; mask: boolean }) {
  if (!value && !focused) return <Text dimColor>{placeholder ?? '(empty)'}</Text>;
  const display = mask ? '•'.repeat(value.length) : value;
  return (
    <Box>
      <Text>{display}</Text>
      {focused && <Text color="cyan">▌</Text>}
    </Box>
  );
}

function TextAreaLines({ value, focused, placeholder }: { value: string; focused: boolean; placeholder?: string }) {
  if (!value && !focused) return <Text dimColor>{placeholder ?? '(empty)'}</Text>;
  return (
    <Box flexDirection="column">
      <Text>{value}{focused ? '▌' : ''}</Text>
    </Box>
  );
}

function SelectRow({ options, value, focused }: { options: { value: string; label?: string }[]; value: string; focused: boolean }) {
  return (
    <Box>
      {options.map(o => {
        const selected = o.value === value;
        return (
          <Box key={o.value} marginRight={2}>
            <Text color={selected ? (focused ? 'cyan' : 'white') : 'gray'} bold={selected && focused}>
              {selected ? '(•) ' : '( ) '}{o.label ?? o.value}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ButtonText({ label, color, focused }: { label: string; color: string; focused: boolean }) {
  return (
    <Text
      color={focused ? 'black' : color}
      backgroundColor={focused ? color : undefined}
      bold={focused}
    >
      {' '}[ {label} ] {' '}
    </Text>
  );
}
