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
    expect(translations.en['agent.edit.title']).toBe('Edit agent');
    expect(translations.ru['agent.edit.title']).toBe('Изменить агента');
    expect(translations.en['agent.new.title']).toBe('New agent');
    expect(translations.ru['agent.new.title']).toBe('Новый агент');
    expect(translations.en['agent.page.bus']).toBe('Bus');
    expect(translations.ru['agent.page.bus']).toBe('Шина');
    expect(translations.en['agent.page.confirmDelete']).toContain('{id}');
    expect(translations.ru['agent.page.confirmDelete']).toContain('{id}');
  });

  it('keeps navigation labels in the translation catalog', () => {
    expect(translations.en['nav.group.operator']).toBe('Operator');
    expect(translations.ru['nav.group.operator']).toBe('Оператор');
    expect(translations.en['nav.overview']).toBe('Overview');
    expect(translations.ru['nav.overview']).toBe('Витрина');
  });

  it('keeps profile and password copy in the translation catalog', () => {
    expect(translations.en['profile.title']).toBe('My profile');
    expect(translations.ru['profile.title']).toBe('Мой профиль');
    expect(translations.en['profile.passwordTooShort']).toContain('12');
    expect(translations.ru['profile.passwordTooShort']).toContain('12');
  });

  it('keeps whitelist access-management copy in the translation catalog', () => {
    expect(translations.en['whitelist.title']).toBe('Whitelist');
    expect(translations.ru['whitelist.title']).toBe('Белый список');
    expect(translations.en['whitelist.flash.userApproved']).toContain('{name}');
    expect(translations.ru['whitelist.flash.groupApproved']).toContain('{chatId}');
  });
});
