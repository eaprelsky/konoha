/**
 * RegistryPicker — modal overlay for selecting role / document / IS.
 * Extracted from ProcessEditor.tsx (issue #330).
 */
import type { RoleDef, DocTemplate } from '../api/types';
import type { EType } from './ArrowRouter';

interface Props {
  picker: 'role' | 'document' | 'is' | null;
  roles: RoleDef[];
  docs: DocTemplate[];
  adapters: string[];
  onPickFromRegistry: (name: string, refId: string) => void;
  onAddCustom: (type: EType) => void;
  onClose: () => void;
}

export function RegistryPicker({ picker, roles, docs, adapters, onPickFromRegistry, onAddCustom, onClose }: Props) {
  if (!picker) return null;

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker-box" onClick={e => e.stopPropagation()}>
        <h3>
          {picker === 'role' ? '👤 Выбрать роль'
           : picker === 'document' ? '📄 Выбрать документ'
           : '🖥 Выбрать информационную систему'}
        </h3>
        <div className="picker-list">
          {picker === 'is'
            ? adapters.map(name => (
                <div key={name} className="picker-item" onClick={() => onPickFromRegistry(name, name)}>
                  <strong>{name}</strong>
                </div>
              ))
            : (picker === 'role' ? roles : docs).map(item => {
                const id   = 'role_id' in item ? item.role_id : item.doc_id;
                const name = item.name;
                const description = 'description' in item ? item.description : undefined;
                return (
                  <div key={id} className="picker-item" onClick={() => onPickFromRegistry(name, id)}>
                    <strong>{name}</strong>
                    {description && (
                      <span style={{ color: '#64748b', fontSize: 11, marginLeft: 8 }}>
                        {description}
                      </span>
                    )}
                  </div>
                );
              })}
        </div>
        <div className="picker-footer">
          <button className="btn-custom" onClick={() => onAddCustom(picker === 'is' ? 'information_system' : picker!)}>
            + Добавить своё
          </button>
          <button className="btn-cancel" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </div>
  );
}
