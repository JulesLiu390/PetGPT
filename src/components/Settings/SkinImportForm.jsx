import { useState } from 'react';
import { Alert, Button, FormGroup, Input, Label } from '../UI/ui';
import * as tauri from '../../utils/tauri';
import { describeSkinImport } from '../Avatar/skinModel';

export default function SkinImportForm({ onSave, onCancel }) {
  const [source, setSource] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const select = async (directory) => {
    try {
      const path = directory ? await tauri.selectDirectory() : await tauri.selectFile({ filters: [{ name: 'Skin / LayerDiff', extensions: ['json'] }], multiple: false });
      if (!path) return;
      setSource(null);
      setError('');
      const descriptor = directory
        ? { kind: 'layered', name: '', detail: 'LayerDiff output or standard skin directory' }
        : describeSkinImport(JSON.parse(await tauri.readFile(path)));
      setSource({ path, ...descriptor });
      setName(descriptor.name || '');
    } catch (err) { setError(String(err.message || err)); }
  };
  const submit = async (event) => {
    event.preventDefault();
    if (!source) return;
    setBusy(true);
    setError('');
    try { await onSave({ ...source, name: name.trim() || null }); }
    catch (err) { setError(String(err.message || err)); }
    finally { setBusy(false); }
  };
  return <form className="space-y-4" onSubmit={submit}>
    {error && <Alert type="error">{error}</Alert>}
    <p className="text-sm text-slate-600">Import LayerDiff output, a standard layered skin package, or an image skin JSON.</p>
    <div className="flex gap-2">
      <Button type="button" variant="secondary" disabled={busy} onClick={() => select(false)}>Select JSON</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={() => select(true)}>Select Folder</Button>
    </div>
    <p className="text-xs text-slate-500">For LayerDiff, keep the *.psd.json file next to its matching image folder. PSD files are optional.</p>
    {source && <>
      <div className="text-sm bg-slate-50 rounded-lg p-3 break-all">{source.path}<div className="text-slate-500 mt-1">{source.detail}</div></div>
      <FormGroup><Label>Skin Name</Label><Input value={name} onChange={e => setName(e.target.value)} maxLength={100} disabled={busy || source.kind === 'image'} placeholder="Use package name" /></FormGroup>
      <p className="text-xs text-slate-500">After importing, choose this skin in the assistant's Avatar settings. LayerDiff skins use a static expression with gentle breathing.</p>
    </>}
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button type="submit" variant="primary" disabled={!source || busy}>{busy ? 'Importing…' : 'Import Skin'}</Button>
    </div>
  </form>;
}
