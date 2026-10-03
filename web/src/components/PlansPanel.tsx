import { useRef, useState } from 'react';
import type { TestPlan, SafetyLevel } from '../types';

interface Props {
  plans: TestPlan[];
  selectedCount: number;
  onSave: (name: string, description?: string) => void;
  onLoad: (plan: TestPlan) => void;
  onDelete: (id: string) => void;
  onImport: (plan: Partial<TestPlan>) => void;
  currentSelection: { testIds: string[]; enabledSafety: SafetyLevel[]; stopOnFailure: boolean };
}

export function PlansPanel({ plans, selectedCount, onSave, onLoad, onDelete, onImport, currentSelection }: Props) {
  const [name, setName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const download = () => {
    const blob = new Blob(
      [JSON.stringify({ name: name || 'atlas-system-tester-plan', ...currentSelection }, null, 2)],
      { type: 'application/json' },
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(name || 'atlas-system-tester-plan').replace(/\s+/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        onImport(parsed);
      } catch {
        alert('Invalid plan JSON');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="card">
      <h2>Test plans</h2>
      <div className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Plan name" />
        <button className="small" disabled={!name || selectedCount === 0} onClick={() => { onSave(name); setName(''); }}>
          Save
        </button>
      </div>
      <div className="row mt small">
        <button className="small ghost" onClick={download} disabled={selectedCount === 0}>Download .json</button>
        <button className="small ghost" onClick={() => fileRef.current?.click()}>Import .json</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])}
        />
      </div>

      <div className="mt">
        {plans.length === 0 ? (
          <div className="small muted">No saved plans yet.</div>
        ) : (
          plans.map((p) => (
            <div className="row" key={p.id} style={{ padding: '5px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div className="small" style={{ fontWeight: 600 }}>{p.name}</div>
                <div className="small muted">{p.testIds.length} tests · {p.enabledSafety.filter((s) => s !== 'read').join(', ') || 'read only'}</div>
              </div>
              <button className="small ghost" onClick={() => onLoad(p)}>Load</button>
              <button className="small danger" onClick={() => onDelete(p.id)}>✕</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
