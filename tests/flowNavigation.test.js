const { getNextScreen } = require('../src/services/flowNavigation');

describe('getNextScreen – INICIO', () => {
  test('opcion_inicio=hablar_alguien → HABLAR_ALGUIEN', () => {
    expect(getNextScreen('INICIO', { opcion_inicio: 'hablar_alguien' })).toBe('HABLAR_ALGUIEN');
  });
  test('opcion_inicio=estres → ESTRES', () => {
    expect(getNextScreen('INICIO', { opcion_inicio: 'estres' })).toBe('ESTRES');
  });
  test('opcion_inicio=informacion → INFORMACION', () => {
    expect(getNextScreen('INICIO', { opcion_inicio: 'informacion' })).toBe('INFORMACION');
  });
  test('opcion_inicio=urgencia → URGENCIA', () => {
    expect(getNextScreen('INICIO', { opcion_inicio: 'urgencia' })).toBe('URGENCIA');
  });
  test('unknown option → null', () => {
    expect(getNextScreen('INICIO', { opcion_inicio: 'desconocida' })).toBeNull();
  });
});

describe('getNextScreen – HABLAR_ALGUIEN', () => {
  test('opcion=agendar → SOLICITUD_ESPACIO', () => {
    expect(getNextScreen('HABLAR_ALGUIEN', { opcion: 'agendar' })).toBe('SOLICITUD_ESPACIO');
  });
  test('opcion=ver_horarios → HORARIOS', () => {
    expect(getNextScreen('HABLAR_ALGUIEN', { opcion: 'ver_horarios' })).toBe('HORARIOS');
  });
  test('unknown option → null', () => {
    expect(getNextScreen('HABLAR_ALGUIEN', { opcion: 'otra' })).toBeNull();
  });
});

describe('getNextScreen – ESTRES', () => {
  test('opcion=si_un_poco → CIERRE', () => {
    expect(getNextScreen('ESTRES', { opcion: 'si_un_poco' })).toBe('CIERRE');
  });
  test('opcion=necesito_hablar → HABLAR_ALGUIEN', () => {
    expect(getNextScreen('ESTRES', { opcion: 'necesito_hablar' })).toBe('HABLAR_ALGUIEN');
  });
  test('opcion=ver_horarios → HORARIOS', () => {
    expect(getNextScreen('ESTRES', { opcion: 'ver_horarios' })).toBe('HORARIOS');
  });
  test('unknown option → null', () => {
    expect(getNextScreen('ESTRES', { opcion: 'otra' })).toBeNull();
  });
});

describe('getNextScreen – INFORMACION', () => {
  test('opcion=agendar → SOLICITUD_ESPACIO', () => {
    expect(getNextScreen('INFORMACION', { opcion: 'agendar' })).toBe('SOLICITUD_ESPACIO');
  });
  test('opcion=salir → CIERRE', () => {
    expect(getNextScreen('INFORMACION', { opcion: 'salir' })).toBe('CIERRE');
  });
  test('unknown option → null', () => {
    expect(getNextScreen('INFORMACION', { opcion: 'otra' })).toBeNull();
  });
});

describe('getNextScreen – unknown screen', () => {
  test('unknown screen → null', () => {
    expect(getNextScreen('PANTALLA_INEXISTENTE', { opcion: 'algo' })).toBeNull();
  });
});
