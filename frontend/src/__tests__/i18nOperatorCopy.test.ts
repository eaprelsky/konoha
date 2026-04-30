import { describe, expect, it } from 'vitest';
import { translations } from '../i18n/translations';

describe('operator i18n terminology', () => {
  it('keeps Run terminology consistent', () => {
    expect(translations.en['label.run']).toBe('Run');
    expect(translations.ru['label.run']).toBe('Прогон');
    expect(translations.en['operator.runs.title']).toBe('Runs');
    expect(translations.ru['operator.runs.title']).toBe('Прогоны');
  });

  it('keeps Work Items queue terminology consistent', () => {
    expect(translations.en['operator.workitems.title']).toBe('Work Items');
    expect(translations.ru['operator.workitems.title']).toBe('Очередь исполнения');
  });

  it('keeps hidden artifact toggles translated in operator surfaces', () => {
    expect(translations.en['operator.monitor.hidden']).toBe('Hidden ({count})');
    expect(translations.ru['operator.monitor.hidden']).toBe('Служебные ({count})');
    expect(translations.en['eventMonitor.hidden']).toBe('Hidden ({count})');
    expect(translations.ru['eventMonitor.hidden']).toBe('Служебные ({count})');
  });

  it('keeps agent lifecycle labels in the translation catalog', () => {
    expect(translations.en['agent.type.core']).toBe('Core');
    expect(translations.ru['agent.type.core']).toBe('Ядро');
    expect(translations.en['status.starting']).toBe('Starting');
    expect(translations.ru['status.starting']).toBe('Запускается');
  });

  it('keeps agent memory copy in the translation catalog', () => {
    expect(translations.en['agent.memory.files']).toBe('Memory files');
    expect(translations.ru['agent.memory.files']).toBe('Файлы памяти');
    expect(translations.en['agent.memory.confirmDelete']).toContain('{filename}');
    expect(translations.ru['agent.memory.confirmDelete']).toContain('{filename}');
  });

  it('keeps agent settings copy in the translation catalog', () => {
    expect(translations.en['agent.settings.corporateName']).toBe('Corporate name *');
    expect(translations.ru['agent.settings.corporateName']).toBe('Корпоративное имя *');
    expect(translations.en['agent.settings.genderNeutral']).toBe('Neutral (they)');
    expect(translations.ru['agent.settings.genderNeutral']).toBe('Средний (они)');
  });
});
