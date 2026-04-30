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

  it('keeps people directory copy in the translation catalog', () => {
    expect(translations.en['people.title']).toBe('People');
    expect(translations.ru['people.title']).toBe('Люди');
    expect(translations.en['people.confirmDelete']).toContain('{name}');
    expect(translations.ru['people.confirmDelete']).toContain('{name}');
  });

  it('keeps document template copy in the translation catalog', () => {
    expect(translations.en['documents.newTitle']).toBe('New document');
    expect(translations.ru['documents.newTitle']).toBe('Новый документ');
    expect(translations.en['documents.confirmDelete']).toContain('{name}');
    expect(translations.ru['documents.confirmDelete']).toContain('{name}');
  });

  it('keeps skill management copy in the translation catalog', () => {
    expect(translations.en['skills.newTitle']).toBe('New skill');
    expect(translations.ru['skills.newTitle']).toBe('Новый навык');
    expect(translations.en['skills.editTitle']).toContain('{name}');
    expect(translations.ru['skills.confirmDelete']).toContain('{name}');
  });

  it('keeps role management copy in the translation catalog', () => {
    expect(translations.en['roles.newTitle']).toBe('New role');
    expect(translations.ru['roles.newTitle']).toBe('Новая роль');
    expect(translations.en['roles.strategy.load-balancing']).toBe('Load balancing');
    expect(translations.ru['roles.confirmDelete']).toContain('{id}');
  });

  it('keeps connector management copy in the translation catalog', () => {
    expect(translations.en['connectors.checkAll']).toBe('Check all');
    expect(translations.ru['connectors.checkAll']).toBe('Проверить все');
    expect(translations.en['connectors.adapter.default']).toBe('Integration adapter');
    expect(translations.ru['connectors.adapter.default']).toBe('Адаптер интеграции');
  });

  it('keeps event log copy in the translation catalog', () => {
    expect(translations.en['eventLog.count']).toContain('{count}');
    expect(translations.ru['eventLog.count']).toContain('{count}');
    expect(translations.en['eventLog.refreshInfo']).toContain('{time}');
    expect(translations.ru['eventLog.refreshInfo']).toContain('{time}');
  });

  it('keeps shared status badge copy in the translation catalog', () => {
    expect(translations.en['statusBadge.assigned']).toBe('Assigned');
    expect(translations.ru['statusBadge.assigned']).toBe('Назначено');
    expect(translations.en['statusBadge.escalated']).toBe('Escalated');
    expect(translations.ru['statusBadge.escalated']).toBe('Эскалация');
  });
});
