/* Repositório local de demonstração. O Firebase está isolado em services/firebase.js. */
export const STORE_KEY = 'conecta-v2-demo-v2';

export const classCatalog = {
  regular: [1, 2, 3].flatMap(year => 'ABCDEF'.split('').map(letter => ({ id: `regular-${year}-${letter}`, name: `${year}º ano ${letter}`, modality: 'regular' }))),
  technical: [
    { id: 'tech-a', name: 'Técnico · A', modality: 'technical' },
    { id: 'tech-ti', name: 'Técnico · TI', modality: 'technical' },
  ],
};

const sampleData = () => {
  const now = Date.now();
  return {
    currentUserId: 'u1',
    users: [
      { id: 'u1', name: 'Marina Oliveira', handle: 'marina.oliveira', role: 'aluno', classId: 'regular-2-B', school: 'Escola Estadual Horizonte', bio: 'Aprendendo, criando e compartilhando. ✨', avatar: '', banner: '', verified: true, privacy: { profileVisible: true, showClass: true, showSchool: false, discoverable: true } },
      { id: 'u2', name: 'Rafael Lima', handle: 'rafael.lima', role: 'professor', classId: '', school: 'Escola Estadual Horizonte', bio: 'Professor de Ciências · projetos e curiosidade.', avatar: '', banner: '', verified: true, privacy: { showClass: true, showSchool: true, discoverable: true } },
      { id: 'u3', name: 'Secretaria Escolar', handle: 'secretaria', role: 'secretaria', classId: '', school: 'Escola Estadual Horizonte', bio: 'Avisos oficiais da comunidade escolar.', avatar: '', banner: '', verified: true, privacy: { showClass: false, showSchool: true, discoverable: true } },
      { id: 'u4', name: 'Lucas Santos', handle: 'lucas.santos', role: 'aluno', classId: 'regular-2-B', school: 'Escola Estadual Horizonte', bio: 'Robótica e basquete.', avatar: '', banner: '', verified: false, privacy: { showClass: true, showSchool: false, discoverable: true } },
    ],
    posts: [
      { id: 'p1', authorId: 'u2', text: 'Bem-vindos ao CONecta! Este é nosso espaço para trocar ideias, compartilhar projetos e ficar por dentro da vida escolar.', image: '', createdAt: now - 3600000, updatedAt: now - 3600000, likes: ['u1', 'u4'], comments: [{ id: 'c1', authorId: 'u1', text: 'Que bom ter esse espaço!', createdAt: now - 1800000 }], moderation: { status: 'clear', signals: [] } },
      { id: 'p2', authorId: 'u3', text: 'Lembrete: a feira de ciências acontece na sexta-feira. Inscrições de projetos abertas na secretaria.', image: '', createdAt: now - 7200000, updatedAt: now - 7200000, likes: [], comments: [], moderation: { status: 'clear', signals: [] } },
    ],
    groups: [
      { id: 'g1', name: 'Feira de Ciências 2026', description: 'Ideias, equipes e organização da feira.', visibility: 'public', category: 'Projetos', ownerId: 'u2', rules: 'Convivência respeitosa. Compartilhe ideias relacionadas aos projetos.', members: [{ userId: 'u1', role: 'member', joinedAt: now - 8000000 }, { userId: 'u2', role: 'owner', joinedAt: now - 9000000 }], joinRequests: [], channels: [{ id: 'ch1', name: 'geral', category: 'Organização', messages: [{ id: 'm1', authorId: 'u2', text: 'Compartilhem ideias para os projetos por aqui!', createdAt: now - 500000, readBy: ['u2'] }] }] },
      { id: 'g2', name: '2º ano B', description: 'Espaço da turma para combinar estudos.', visibility: 'private', category: 'Turmas', ownerId: 'u4', rules: 'Respeito e apoio entre colegas. Não publique dados pessoais.', members: [{ userId: 'u1', role: 'member', joinedAt: now - 7000000 }, { userId: 'u4', role: 'owner', joinedAt: now - 8000000 }], joinRequests: [], channels: [{ id: 'ch2', name: 'geral', category: 'Conversa', messages: [{ id: 'm2', authorId: 'u4', text: 'Bem-vindos ao grupo de estudos da turma.', createdAt: now - 250000, readBy: ['u4'] }] }] },
      { id: 'g3', name: 'Clube de Leitura', description: 'Indicações e encontros para quem gosta de ler.', visibility: 'public', category: 'Interesses', ownerId: 'u1', rules: 'Críticas às obras são bem-vindas; ataques a pessoas não.', members: [{ userId: 'u1', role: 'owner', joinedAt: now - 6000000 }], joinRequests: [], channels: [{ id: 'ch3', name: 'indicações', category: 'Leitura', messages: [] }] },
    ],
    notices: [{ id: 'n1', title: 'Feira de Ciências', text: 'Sexta-feira, no pátio central. Inscrições de projetos abertas.', createdAt: now - 600000 }],
    events: [{ id: 'e1', title: 'Feira de Ciências', date: '2026-10-16', type: 'Evento', description: 'Apresentação dos projetos no pátio central.' }, { id: 'e2', title: 'Entrega: projeto de biologia', date: '2026-10-20', type: 'Trabalho', description: 'Entrega para a turma.' }],
    reports: [], audit: [], blockedUserIdsByUser: {}, hiddenPostIdsByUser: {}, hiddenPostIds: [], hiddenMessageIds: [],
    settings: { theme: 'light', font: 'normal', textScale: 100, highContrast: false, reduceMotion: false, reduceTransparency: false, privacy: { profileVisible: true, showClass: true, showSchool: false } },
  };
};

export function emptyState(profile) {
  const state = sampleData();
  state.currentUserId = profile.id;
  state.users = [profile];
  state.posts = [];
  state.groups = [];
  state.notices = [];
  state.events = [];
  state.reports = [];
  state.audit = [];
  state.hiddenPostIds = [];
  state.hiddenMessageIds = [];
  state.blockedUserIdsByUser = {};
  state.hiddenPostIdsByUser = {};
  state.users[0].privacy ||= { profileVisible: true, showClass: false, showSchool: false, discoverable: true };
  return state;
}

function validateState(candidate) {
  const fresh = sampleData();
  if (!candidate || typeof candidate !== 'object') return fresh;
  for (const key of Object.keys(fresh)) if (!(key in candidate)) candidate[key] = fresh[key];
  const lists = ['users', 'posts', 'groups', 'notices', 'events', 'reports', 'audit', 'hiddenPostIds', 'hiddenMessageIds'];
  for (const key of lists) if (!Array.isArray(candidate[key])) candidate[key] = fresh[key];
  if (!candidate.blockedUserIdsByUser || typeof candidate.blockedUserIdsByUser !== 'object' || Array.isArray(candidate.blockedUserIdsByUser)) candidate.blockedUserIdsByUser = {};
  if (!candidate.hiddenPostIdsByUser || typeof candidate.hiddenPostIdsByUser !== 'object' || Array.isArray(candidate.hiddenPostIdsByUser)) candidate.hiddenPostIdsByUser = {};
  if (!candidate.settings || typeof candidate.settings !== 'object') candidate.settings = fresh.settings;
  if (!candidate.settings.privacy) candidate.settings.privacy = fresh.settings.privacy;
  if (!candidate.users.some(user => user.id === candidate.currentUserId)) candidate.currentUserId = fresh.currentUserId;
  return candidate;
}

export const DemoRepository = {
  load() {
    try { return validateState(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); }
    catch { return sampleData(); }
  },
  save(state) { localStorage.setItem(STORE_KEY, JSON.stringify(state)); },
  reset() { localStorage.removeItem(STORE_KEY); return sampleData(); },
};

export const AuthAdapter = {
  mode: 'demo',
  async request() { return { ok: false, demo: true, message: 'Serviço de autenticação não conectado. Nenhuma credencial foi enviada ou armazenada.' }; },
};

export const StorageAdapter = {
  mode: 'local-preview',
  async image(file) {
    if (!file || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Escolha uma imagem PNG, JPEG, WebP ou GIF.');
    if (file.size > 1200000) throw new Error('Use uma imagem de até 1,2 MB nesta prévia local.');
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
      reader.readAsDataURL(file);
    });
  },
};

export function normalizeForModeration(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[аеорсхуіј]/g, ch => ({ а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j' })[ch] || ch)
    .replace(/(^|\s)!+|!+(?=$|\s)/g, ' ')
    .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/\$/g, 's')
    .replace(/(.)\1{1,}/g, '$1').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Extensible, review-first rules. This heuristic never makes permanent account decisions. */
const moderationRules = [
  { code: 'threat', label: 'Possível ameaça', pattern: /\b(vou te matar|vou matar voce|ameaca de morte|morte para voce|vou te encontrar e)\b/, priority: 'high' },
  { code: 'severe-insult', label: 'Possível insulto grave', pattern: /\b(vai tomar no cu|filho da puta|desgracado|retardado)\b/, priority: 'normal' },
  { code: 'violence', label: 'Possível incentivo à violência', pattern: /\b(vamos atacar|ataquem (a|os|as)|mate(m)? todos|vamos explodir)\b/, priority: 'high' },
  { code: 'hate', label: 'Possível ataque discriminatório', pattern: /\b(inferior por (sua )?raca|morte a (todos os )?(imigrantes|[a-z]+ por sua raca)|expulsar todos os [a-z]+ por)\b/, priority: 'high' },
  { code: 'extremism', label: 'Possível propaganda extremista', pattern: /\b(heil hitler|supremacia ariana|exterminio de (um )?povo|nazismo e a solucao|junte se a (um )?grupo neonazista)\b/, priority: 'high' },
  { code: 'minor-safety', label: 'Possível risco grave à segurança de menores', pattern: /\b(enviar fotos intimas de (uma )?crianca|encontro sexual com (uma )?crianca|explorar sexualmente (uma )?crianca)\b/, priority: 'urgent' },
  { code: 'harassment', label: 'Possível assédio ou perseguição', pattern: /\b(vou te perseguir|nao vou parar de te seguir|vou divulgar seu endereco)\b/, priority: 'high' },
  { code: 'spam', label: 'Possível spam ou tentativa de burlar filtros', pattern: /\b(clique aqui para ganhar|envie sua senha|http\s+http\s+http)\b/, priority: 'normal' },
];
const educationalContext = /\b(aula|historia|historico|jornalismo|reportagem|pesquisa|estudo|educativo|documentario|contexto historico)\b/;
export function reviewSignals(value) {
  const text = normalizeForModeration(value);
  const matches = moderationRules.filter(rule => rule.pattern.test(text));
  const educational = educationalContext.test(text);
  return {
    status: matches.length ? 'review' : 'clear',
    signals: matches.map(({ code, label, priority }) => ({ code, label, priority })),
    educationalContext: educational,
    blockPreview: matches.some(match => match.priority === 'urgent') && !educational,
  };
}

export function canAccessGroup(group, userId) {
  return Boolean(group && (group.visibility === 'public' || group.members.some(member => member.userId === userId)));
}
export function groupRole(group, userId) {
  return group?.members.find(member => member.userId === userId)?.role || null;
}
export function canManageGroup(group, userId) {
  return ['owner', 'moderator'].includes(groupRole(group, userId));
}
