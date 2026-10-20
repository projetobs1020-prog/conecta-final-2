import {
  AuthAdapter, DemoRepository, StorageAdapter, canAccessGroup, canManageGroup,
  classCatalog, groupRole, reviewSignals,
} from './data.js';
import { FirebaseAuthAdapter, FirebaseRepository, firebaseConfigured } from './services/firebase.js';
import { LibrasAdapter } from './services/libras.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const dialogBody = document.querySelector('#dialog-body');
const safeLocalImage = value => {
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(String(value || ''))) return value;
  try { const imageUrl = new URL(String(value)); return imageUrl.origin === 'https://firebasestorage.googleapis.com' ? imageUrl.href : ''; }
  catch { return ''; }
};
let state = DemoRepository.load();
state.users.forEach(user => { user.avatar = safeLocalImage(user.avatar); user.banner = safeLocalImage(user.banner); });
state.posts.forEach(post => { post.image = safeLocalImage(post.image); });
let page = 'feed';
let selectedGroupId = '';
let selectedChannelId = '';
let viewUserId = '';
let searchTerm = '';
let authMode = 'login';
let pendingInviteCodes = new Map(); // Deliberately memory-only: never persist access codes.
let toastTimeout;
const firebaseMode = firebaseConfigured();
let firebaseStatus = firebaseMode ? 'checking' : 'demo';
let firebaseUser = null;
let firebaseUnsubscribe = null;
let firebaseError = '';
let cloudSaveQueue = Promise.resolve();

const currentUser = () => state.users.find(user => user.id === state.currentUserId);
const blockedUserIds = () => state.blockedUserIdsByUser[currentUser().id] || [];
const hiddenPostIds = () => state.hiddenPostIdsByUser[currentUser().id] || [];
const userById = id => state.users.find(user => user.id === id) || { id: '', name: 'Pessoa da comunidade', handle: 'usuario', verified: false, role: 'aluno' };
const currentGroup = () => state.groups.find(group => group.id === selectedGroupId);
const currentChannel = group => group?.channels.find(channel => channel.id === selectedChannelId) || group?.channels[0];
const initials = name => String(name || '?').trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const isStaff = () => ['professor', 'secretaria', 'administrador'].includes(currentUser()?.role);
const roleLabels = { aluno: 'Aluno', professor: 'Professor', secretaria: 'Secretaria', administrador: 'Administrador' };
const classLabel = classId => [...classCatalog.regular, ...classCatalog.technical].find(item => item.id === classId)?.name || '';
const validPages = new Set(['feed', 'groups', 'calendar', 'notifications', 'search', 'profile', 'settings', 'admin']);

function setRoute(nextPage, { userId = '', groupId = '', channelId = '' } = {}) {
  page = validPages.has(nextPage) ? nextPage : 'feed';
  viewUserId = page === 'profile' ? userId : '';
  selectedGroupId = page === 'groups' ? groupId : '';
  selectedChannelId = page === 'groups' ? channelId : '';
  const parts = [page];
  if (page === 'profile' && viewUserId) parts.push(viewUserId);
  if (page === 'groups' && selectedGroupId) parts.push(selectedGroupId);
  if (page === 'groups' && selectedChannelId) parts.push(selectedChannelId);
  const route = `#/${parts.map(encodeURIComponent).join('/')}`;
  if (location.hash !== route) history.pushState(null, '', route);
}

function restoreRoute() {
  if (firebaseMode && firebaseStatus !== 'ready') { render(); return; }
  let parts = [];
  try { parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent); }
  catch { parts = []; }
  const [requestedPage, firstId = '', secondId = ''] = parts;
  page = validPages.has(requestedPage) ? requestedPage : 'feed';
  if (page === 'admin' && !isStaff()) page = 'feed';
  viewUserId = page === 'profile' ? firstId : '';
  selectedGroupId = '';
  selectedChannelId = '';
  if (page === 'groups' && firstId) {
    const group = state.groups.find(item => item.id === firstId);
    if (group && canAccessGroup(group, currentUser().id)) {
      selectedGroupId = group.id;
      selectedChannelId = group.channels.some(channel => channel.id === secondId) ? secondId : (group.channels[0]?.id || '');
    }
  }
  const normalized = `#/${page}${page === 'profile' && viewUserId ? `/${encodeURIComponent(viewUserId)}` : ''}${page === 'groups' && selectedGroupId ? `/${encodeURIComponent(selectedGroupId)}${selectedChannelId ? `/${encodeURIComponent(selectedChannelId)}` : ''}` : ''}`;
  if (location.hash !== normalized) history.replaceState(null, '', normalized);
  render();
}

function save({ rerender = true } = {}) {
  if (firebaseMode && firebaseStatus === 'ready') {
    const snapshot = structuredClone(state);
    cloudSaveQueue = cloudSaveQueue.then(() => FirebaseRepository.save(snapshot)).catch(async error => {
      try { state = await FirebaseRepository.load(firebaseUser, await FirebaseAuthAdapter.claims(firebaseUser)); render(); } catch { /* Keep the screen usable while displaying the original write failure. */ }
      toast(error.message || 'O Firebase recusou a gravação. Confira as regras e a conexão.');
    });
  } else if (!firebaseMode) {
    try { DemoRepository.save(state); }
    catch { toast('O armazenamento local está cheio. Remova uma imagem grande ou apague dados da demonstração.'); }
  }
  applyPreferences();
  if (rerender) render();
}

function renderFirebaseGate() {
  const heading = firebaseStatus === 'checking' || firebaseStatus === 'loading' ? 'Conectando ao CONecta' : firebaseStatus === 'unverified' ? 'Confirme seu e-mail' : 'Entre na comunidade escolar';
  const detail = firebaseStatus === 'checking' || firebaseStatus === 'loading'
    ? 'Validando sua sessão e carregando dados protegidos do Firebase…'
    : firebaseStatus === 'unverified'
      ? 'Abra o link enviado para seu endereço escolar. A confirmação é validada pelo Firebase Auth.'
      : firebaseError || 'Entre com sua conta Firebase ou crie uma conta escolar para continuar.';
  app.innerHTML = `<main class="firebase-gate" aria-labelledby="firebase-gate-title"><div class="firebase-gate-card"><span class="brand-symbol">C</span><p class="eyebrow">CONecta V2 · FIREBASE</p><h1 id="firebase-gate-title">${heading}</h1><p>${esc(detail)}</p>${firebaseStatus === 'unverified' ? `<div class="gate-actions">${action('Reenviar link de confirmação', 'resend-verification', { cls: 'button button-primary' })}${action('Já confirmei meu e-mail', 'reload-auth', { cls: 'button button-outline' })}${action('Sair', 'sign-out', { cls: 'text-action' })}</div>` : firebaseStatus === 'checking' || firebaseStatus === 'loading' ? '<span class="loading-dot" aria-label="Carregando"></span>' : `<div class="gate-actions">${action('Entrar', 'auth', { cls: 'button button-primary' })}${action('Criar conta', 'auth-signup', { cls: 'button button-outline' })}</div><p class="gate-note">Os dados só serão acessados após autenticação. Configure os provedores de e-mail e senha no Firebase Console.</p>`}</div></main>`;
}

async function onFirebaseUser(user) {
  firebaseUser = user;
  firebaseError = '';
  if (!user) { firebaseStatus = 'signed-out'; render(); return; }
  if (!user.emailVerified) { firebaseStatus = 'unverified'; render(); return; }
  firebaseStatus = 'loading'; render();
  try {
    const claims = await FirebaseAuthAdapter.claims(user);
    state = await FirebaseRepository.load(user, claims);
    state.users.forEach(person => { person.avatar = safeLocalImage(person.avatar); person.banner = safeLocalImage(person.banner); });
    state.posts.forEach(post => { post.image = safeLocalImage(post.image); });
    firebaseStatus = 'ready';
    restoreRoute();
  } catch (error) {
    firebaseStatus = 'error';
    firebaseError = error.message || 'Não foi possível carregar o perfil e os dados no Firebase.';
    render();
  }
}

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), 3300);
}

function avatar(user, size = '', extraClass = '') {
  const name = typeof user === 'string' ? user : user?.name;
  const image = typeof user === 'object' ? safeLocalImage(user?.avatar) : '';
  return image
    ? `<img class="avatar ${size} ${extraClass}" src="${esc(image)}" alt="Foto de perfil de ${esc(name)}">`
    : `<span class="avatar ${size} ${extraClass}" aria-hidden="true">${esc(initials(name))}</span>`;
}

function action(label, name, { id: itemId = '', cls = 'button button-outline', aria = '' } = {}) {
  return `<button type="button" class="${cls}" data-action="${esc(name)}" ${itemId ? `data-id="${esc(itemId)}"` : ''} ${aria ? `aria-label="${esc(aria)}"` : ''}>${label}</button>`;
}

function navLink(key, title, icon, compact = false) {
  const unread = key === 'notifications' ? unreadMessageCount() : 0;
  return `<button type="button" class="nav-item ${page === key ? 'active' : ''}" data-page="${key}" aria-current="${page === key ? 'page' : 'false'}"><span class="nav-icon" aria-hidden="true">${icon}</span><span>${title}</span>${unread ? `<span class="count-badge">${unread}</span>` : ''}</button>`;
}

function unreadMessageCount() {
  const me = currentUser()?.id;
  return state.groups.filter(group => canAccessGroup(group, me)).reduce((sum, group) => sum + group.channels.reduce((chSum, channel) => chSum + channel.messages.filter(message => message.authorId !== me && !message.readBy?.includes(me) && !blockedUserIds().includes(message.authorId) && !state.hiddenMessageIds.includes(`${group.id}|${message.id}`)).length, 0), 0);
}

function headerRail() {
  const next = [...state.events].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  return `<aside class="right-rail" aria-label="Informações úteis">
    <section class="panel"><div class="panel-heading"><h2>Avisos oficiais</h2><span class="verified-mark" aria-label="Oficial">✓</span></div>
      ${state.notices.slice(0, 2).map(notice => `<article class="rail-notice"><p class="eyebrow">COMUNIDADE ESCOLAR</p><h3>${esc(notice.title)}</h3><p>${esc(notice.text)}</p><time>${new Date(notice.createdAt).toLocaleDateString('pt-BR')}</time></article>`).join('') || '<p class="quiet">Nenhum aviso publicado.</p>'}
    </section>
    <section class="panel"><div class="panel-heading"><h2>Próximas datas</h2>${action('Ver agenda', 'go-calendar', { cls: 'text-action' })}</div>
      ${next.map(event => `<div class="event-row"><time class="date-chip"><b>${esc(event.date.slice(8))}</b><span>${esc(event.date.slice(5, 7))}</span></time><div><b>${esc(event.title)}</b><span>${esc(event.type)}</span></div></div>`).join('') || '<p class="quiet">Sua agenda está livre.</p>'}
    </section>
    <section class="panel privacy-prompt"><span class="shield-icon" aria-hidden="true">◇</span><h2>Sua comunidade, com cuidado</h2><p>Compartilhe apenas o que faz sentido para sua vida escolar.</p>${action('Como cuidamos dos dados', 'privacy', { cls: 'button button-outline button-full' })}</section>
  </aside>`;
}

function navigation() {
  return `<aside class="left-rail"><a class="brand" href="#inicio" data-page="feed" aria-label="CONecta V2, início"><span class="brand-symbol">C</span><span>CONecta<small>COMUNIDADE ESCOLAR</small></span></a>
    <nav class="main-nav" aria-label="Navegação principal">
      ${navLink('feed', 'Início', '⌂')}${navLink('groups', 'Grupos e canais', '▤')}${navLink('calendar', 'Calendário', '▦')}${navLink('notifications', 'Notificações', '♧')}${navLink('search', 'Explorar', '⌕')}${navLink('profile', 'Meu perfil', '◉')}${navLink('settings', 'Preferências', '⚙')}
      ${isStaff() ? navLink('admin', 'Painel da equipe', '⌘') : ''}
    </nav>
    <button class="account-chip" data-action="account-menu">${avatar(currentUser(), 'avatar-small')}<span class="account-copy"><b>${esc(currentUser().name)}</b><small>@${esc(currentUser().handle)} · ${esc(roleLabels[currentUser().role])}</small></span><span aria-hidden="true">···</span></button>
  </aside>`;
}

function mobileNav() {
  return `<nav class="mobile-nav" aria-label="Navegação móvel">${navLink('feed', 'Início', '⌂', true)}${navLink('groups', 'Grupos', '▤', true)}${navLink('search', 'Buscar', '⌕', true)}${navLink('notifications', 'Avisos', '♧', true)}${navLink('profile', 'Perfil', '◉', true)}</nav>`;
}

const pageTitles = { feed: ['Sua comunidade', 'Converse, acompanhe e participe da vida escolar.'], groups: ['Grupos e canais', 'Encontre sua turma, projeto ou espaço de conversa.'], calendar: ['Calendário escolar', 'Provas, trabalhos e momentos da comunidade.'], notifications: ['Notificações', 'Avisos e atualizações dos seus grupos.'], search: ['Explorar', 'Encontre pessoas, publicações e grupos públicos.'], profile: ['Seu perfil', 'Sua identidade na comunidade escolar.'], settings: ['Preferências', 'Ajuste a experiência ao seu jeito.'], admin: ['Painel da equipe', 'Ferramentas de cuidado e gestão da comunidade.'] };

function render() {
  if (firebaseMode && firebaseStatus !== 'ready') { renderFirebaseGate(); return; }
  const [title, subtitle] = pageTitles[page] || pageTitles.feed;
  app.innerHTML = `<div class="app-frame">${navigation()}<main id="main" class="main-column" tabindex="-1"><header class="page-header"><div><p class="eyebrow">CONecta V2 <span>·</span> ${firebaseMode ? 'FIREBASE CONECTADO' : 'DEMONSTRAÇÃO LOCAL'}</p><h1>${title}</h1><p>${subtitle}</p></div><button class="header-search" data-page="search" aria-label="Buscar"><span aria-hidden="true">⌕</span><kbd>Buscar</kbd></button></header><div class="page-content">${renderPage()}</div></main>${headerRail()}</div>${mobileNav()}`;
  if (firebaseMode) {
    document.querySelectorAll('[data-demo-role], [data-demo-user]').forEach(control => control.closest('.section-card')?.remove());
    document.querySelector('.demo-data-card')?.remove();
    document.querySelector('[data-action="clear-data"]')?.remove();
    if (page === 'settings') document.querySelector('.page-content')?.insertAdjacentHTML('beforeend', `<section class="card section-card"><p class="eyebrow">INTEGRAÇÃO PREPARADA</p><h2>API de Libras</h2><p>${LibrasAdapter.ready ? 'Serviço de Libras conectado.' : 'A conexão ainda não está ativa.'} A chave deve ficar em segredo no Firebase Functions, nunca neste navegador. Consulte <code>integrations/libras/README.md</code> para concluir a integração quando tiver os dados do provedor.</p></section>`);
  }
  applyPreferences();
}

function renderPage() {
  if (page === 'feed') return feedView();
  if (page === 'groups') return groupsView();
  if (page === 'calendar') return calendarView();
  if (page === 'notifications') return notificationsView();
  if (page === 'search') return searchView();
  if (page === 'profile') return profileView(viewUserId || currentUser().id);
  if (page === 'settings') return settingsView();
  if (page === 'admin') return adminView();
  return feedView();
}

function feedView() {
  const posts = visiblePosts();
  return `<section class="composer card" aria-label="Criar publicação">${avatar(currentUser())}<form data-form="post" class="composer-form"><label for="new-post" class="visually-hidden">O que você quer compartilhar?</label><textarea id="new-post" name="text" maxlength="1500" placeholder="O que você quer compartilhar com a comunidade?" required></textarea><div class="composer-bottom"><label class="file-button"><span>＋ Foto</span><input class="visually-hidden" type="file" name="image" accept="image/*" aria-label="Adicionar foto"></label><label class="image-alt-label">Descrição da imagem <input name="imageAlt" maxlength="180" placeholder="Texto alternativo (opcional)" aria-label="Descrição alternativa da imagem"></label><span class="quiet">Publique com respeito e cuidado.</span><button class="button button-primary" type="submit">Publicar</button></div></form></section>
    ${state.notices.map(notice => `<article class="official-banner"><span class="official-icon">✳</span><div><span class="eyebrow">AVISO OFICIAL</span><h2>${esc(notice.title)}</h2><p>${esc(notice.text)}</p></div></article>`).join('')}
    <div class="feed-toolbar"><div class="feed-tabs"><span class="feed-tab active">Para você</span><span class="feed-demo-pill">${firebaseMode ? 'Firebase' : 'Prévia local'}</span></div>${action('Regras da comunidade', 'community-rules', { cls: 'text-action' })}</div>
    <section class="feed-list" aria-label="Publicações">${posts.length ? posts.map(postCard).join('') : `<div class="card empty-state"><span>✳</span><h2>Seu feed está pronto para começar</h2><p>Compartilhe uma ideia, uma conquista ou uma pergunta para sua comunidade.</p></div>`}</section>`;
}

function visiblePosts() {
  return state.posts.filter(post => !state.hiddenPostIds.includes(post.id) && !hiddenPostIds().includes(post.id) && !blockedUserIds().includes(post.authorId));
}

function postCard(post) {
  const author = userById(post.authorId);
  const own = author.id === currentUser().id;
  const liked = post.likes.includes(currentUser().id);
  const flagged = post.moderation?.status === 'review';
  const comments = (post.comments || []).filter(comment => !blockedUserIds().includes(comment.authorId));
  return `<article class="post-card card" aria-label="Publicação de ${esc(author.name)}" data-post-id="${esc(post.id)}">
    <header class="post-header">${avatar(author, 'avatar-post')}<div class="post-author"><button class="identity-link" data-action="view-profile" data-id="${esc(author.id)}">${esc(author.name)}</button><span class="author-badges">${author.verified ? '<span class="verified-mark" role="img" aria-label="Selo de verificação demonstrativo; serviço não conectado" title="Selo de exemplo; identidade escolar não validada" >✓</span>' : ''}${flagged ? '<span class="review-pill">Em revisão</span>' : ''}</span><div class="post-meta">@${esc(author.handle)} <span>·</span> ${esc(classLabel(author.classId) || roleLabels[author.role])} <span>·</span> <time datetime="${new Date(post.createdAt).toISOString()}">${relativeTime(post.createdAt)}</time></div></div><button class="icon-button post-menu" data-action="post-menu" data-id="${esc(post.id)}" aria-label="Opções da publicação de ${esc(author.name)}">•••</button></header>
    <div class="post-copy">${esc(post.text)}</div>${post.image ? `<img class="post-image" src="${esc(post.image)}" alt="${esc(post.imageAlt || `Imagem compartilhada por ${author.name}`)}">` : ''}
    <div class="post-actions"><button class="post-action ${liked ? 'liked' : ''}" data-action="like" data-id="${esc(post.id)}" aria-pressed="${liked}"><span aria-hidden="true">${liked ? '♥' : '♡'}</span> Curtir <span class="action-count">${post.likes.length || ''}</span></button><button class="post-action" data-action="focus-comment" data-id="${esc(post.id)}"><span aria-hidden="true">◷</span> Comentar <span class="action-count">${comments.length || ''}</span></button><button class="post-action" data-action="report-post" data-id="${esc(post.id)}"><span aria-hidden="true">⚑</span> Denunciar</button></div>
    <div class="comment-list">${comments.map(comment => { const person = userById(comment.authorId); return `<div class="comment-row">${avatar(person, 'avatar-comment')}<div><button class="identity-link" data-action="view-profile" data-id="${esc(person.id)}">${esc(person.name)}</button><p>${esc(comment.text)}</p></div></div>`; }).join('')}<form class="comment-form" data-form="comment" data-id="${esc(post.id)}">${avatar(currentUser(), 'avatar-comment')}<label class="visually-hidden" for="comment-${esc(post.id)}">Escreva um comentário</label><input id="comment-${esc(post.id)}" name="text" maxlength="400" placeholder="Escreva um comentário…" required><button class="icon-button send-button" aria-label="Enviar comentário" type="submit">↑</button></form></div>
  </article>`;
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'agora';
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.floor(seconds / 3600)} h`;
  return new Date(timestamp).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' });
}

function groupCard(group) {
  const member = group.members.some(entry => entry.userId === currentUser().id);
  const unread = group.channels.reduce((sum, channel) => sum + channel.messages.filter(message => message.authorId !== currentUser().id && !message.readBy?.includes(currentUser().id) && !blockedUserIds().includes(message.authorId) && !state.hiddenMessageIds.includes(`${group.id}|${message.id}`)).length, 0);
  const requested = group.joinRequests.some(request => request.userId === currentUser().id);
  return `<article class="group-card"><div class="group-glyph" aria-hidden="true">${esc(initials(group.name))}</div><div class="group-card-copy"><div class="group-name-line"><h3>${esc(group.name)}</h3><span class="visibility-tag">${group.visibility === 'private' ? '◇ Privado' : '○ Público'}</span></div><p>${esc(group.description)}</p><div class="group-card-meta"><span>${esc(group.category)}</span><span>·</span><span>${group.memberCount ?? group.members.length} membros</span>${unread ? `<span class="unread-dot">${unread} novas</span>` : ''}</div></div><div class="group-card-action">${member ? action('Abrir', 'select-group', { id: group.id, cls: 'button button-outline' }) : group.visibility === 'public' ? action('Participar', 'join-public', { id: group.id, cls: 'button button-outline' }) : action(requested ? 'Solicitado' : 'Solicitar acesso', 'request-join', { id: group.id, cls: 'button button-outline', aria: requested ? 'Solicitação pendente' : `Solicitar acesso a ${group.name}` })}</div></article>`;
}

function groupsView() {
  const memberGroups = state.groups.filter(group => group.members.some(entry => entry.userId === currentUser().id));
  const publicGroups = state.groups.filter(group => group.visibility === 'public' && !group.members.some(entry => entry.userId === currentUser().id));
  const privateGroups = state.groups.filter(group => group.visibility === 'private' && !group.members.some(entry => entry.userId === currentUser().id));
  const selected = currentGroup();
  const accessible = selected && canAccessGroup(selected, currentUser().id);
  return `<section class="card section-card"><div class="section-heading"><div><p class="eyebrow">SUA COMUNIDADE</p><h2>Seus grupos</h2><p>Conversas organizadas em canais para cada assunto.</p></div>${action('＋ Criar grupo', 'create-group', { cls: 'button button-primary' })}</div>
      ${memberGroups.length ? `<div class="group-list">${memberGroups.map(groupCard).join('')}</div>` : '<div class="empty-inline">Você ainda não participa de grupos.</div>'}
      <div class="section-divider"></div><div class="section-heading compact-heading"><div><h2>Descobrir grupos públicos</h2><p>Encontre um espaço novo para participar.</p></div></div>
      ${publicGroups.length ? `<div class="group-list">${publicGroups.map(groupCard).join('')}</div>` : '<div class="empty-inline">Não há grupos públicos novos por aqui.</div>'}
      ${privateGroups.length ? `<div class="section-divider"></div><div class="section-heading compact-heading"><div><h2>Grupos privados</h2><p>Você pode solicitar entrada; a equipe responsável precisa aprovar.</p></div></div><div class="group-list">${privateGroups.map(groupCard).join('')}</div>` : ''}
    </section>
    ${accessible ? groupDetail(selected) : ''}
    <section class="card invite-card"><div class="invite-mark">⌁</div><div><h2>Tem um convite?</h2><p>Use o código compartilhado pela pessoa responsável pelo grupo privado.</p></div>${action('Inserir código', 'enter-invite', { cls: 'button button-outline' })}</section>
    <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">CONFIGURAÇÃO ESCOLAR</p><h2>Turmas organizadas</h2><p>Ensino regular e técnico ficam separados e podem ser renomeados conforme a escola.</p></div></div><div class="class-grid"><div class="class-config"><b>Ensino regular</b><span>1º, 2º e 3º ano · A, B, C, D, E e F</span><small>${classCatalog.regular.length} identificadores de exemplo</small></div><div class="class-config technical"><b>Ensino técnico</b><span>Modalidade e identificadores ajustáveis</span><small>Exemplos: A, TI</small></div></div></section>`;
}

function groupDetail(group) {
  if (!canAccessGroup(group, currentUser().id)) return '<div class="card empty-state">Você não tem acesso a este grupo.</div>';
  const channel = currentChannel(group);
  const role = groupRole(group, currentUser().id);
  const groupedChannels = Object.groupBy ? Object.groupBy(group.channels, item => item.category || 'Geral') : group.channels.reduce((map, item) => ((map[item.category || 'Geral'] ||= []).push(item), map), {});
  const messages = channel?.messages.filter(message => !blockedUserIds().includes(message.authorId) && !state.hiddenMessageIds.includes(`${group.id}|${message.id}`)) || [];
  return `<section class="card group-detail" aria-label="Grupo ${esc(group.name)}"><header class="group-detail-header"><div class="group-glyph large-glyph">${esc(initials(group.name))}</div><div class="group-detail-title"><p class="eyebrow">${esc(group.category)} <span>·</span> ${group.visibility === 'private' ? 'GRUPO PRIVADO' : 'GRUPO PÚBLICO'}</p><h2>${esc(group.name)}</h2><p>${esc(group.description)}</p></div><button class="icon-button" data-action="group-menu" data-id="${esc(group.id)}" aria-label="Opções do grupo">•••</button></header>
    <div class="group-layout"><aside class="channel-sidebar"><div class="channel-sidebar-top"><span>CANAIS</span>${canManageGroup(group, currentUser().id) ? action('＋', 'add-channel', { id: group.id, cls: 'icon-button', aria: 'Adicionar canal' }) : ''}</div>${Object.entries(groupedChannels).map(([category, channels]) => `<div class="channel-category"><b>${esc(category)}</b>${channels.map(item => `<button class="channel-link ${item.id === channel?.id ? 'active' : ''}" data-action="select-channel" data-id="${esc(item.id)}"># ${esc(item.name)}</button>`).join('')}</div>`).join('')}<div class="group-rules"><b>Regras do grupo</b><p>${esc(group.rules)}</p><span>${group.members.length} membros · Seu papel: ${role === 'owner' ? 'responsável' : role === 'moderator' ? 'moderador' : 'membro'}</span></div></aside>
      <div class="channel-content"><header class="channel-heading"><div><h3># ${esc(channel?.name || 'geral')}</h3><p>${esc(group.name)} · ${firebaseMode ? 'mensagens no Firebase' : 'conversa demonstrativa'}</p></div><span class="online-mark">● ${firebaseMode ? 'Sincronizado' : 'Local'}</span></header><div class="message-list" aria-live="polite">${messages.length ? messages.map(message => { const person = userById(message.authorId); return `<article class="message-row">${avatar(person, 'avatar-comment')}<div><div class="message-meta"><button class="identity-link" data-action="view-profile" data-id="${esc(person.id)}">${esc(person.name)}</button><time>${relativeTime(message.createdAt)}</time>${person.verified ? '<span class="verified-mark" role="img" aria-label="Selo de verificação demonstrativo; serviço não conectado" title="Selo de exemplo; identidade escolar não validada" >✓</span>' : ''}${message.moderation?.status === 'review' ? '<span class="review-pill">Em revisão</span>' : ''}</div><p>${esc(message.text)}</p></div><button class="icon-button message-report" data-action="report-message" data-id="${esc(group.id)}|${esc(message.id)}" aria-label="Denunciar mensagem de ${esc(person.name)}">⚑</button></article>`; }).join('') : '<div class="empty-inline message-empty">Este canal está começando. Envie a primeira mensagem.</div>'}</div>
        <form class="message-form" data-form="message" data-group="${esc(group.id)}" data-channel="${esc(channel?.id || '')}"><label class="visually-hidden" for="message-${esc(channel?.id || 'new')}">Mensagem no canal ${esc(channel?.name || 'geral')}</label><input id="message-${esc(channel?.id || 'new')}" name="text" maxlength="1000" placeholder="Escreva em #${esc(channel?.name || 'geral')}…" required><button class="button button-primary" type="submit" aria-label="Enviar mensagem">Enviar <span aria-hidden="true">↑</span></button></form>
      </div></div><footer class="group-detail-footer">${action('Convidar alguém', 'issue-invite', { id: group.id, cls: 'text-action' })}${action('Denunciar grupo', 'report-group', { id: group.id, cls: 'text-action' })}${action('Sair do grupo', 'leave-group', { id: group.id, cls: 'text-action danger-text' })}</footer>
    ${canManageGroup(group, currentUser().id) ? `<div class="member-tools"><div class="section-heading compact-heading"><div><h3>Gestão de membros</h3><p>Solicitações e papéis locais de demonstração.</p></div></div>${group.joinRequests.map(request => `<div class="member-row">${avatar(userById(request.userId), 'avatar-comment')}<span>${esc(userById(request.userId).name)} pediu para entrar</span>${action('Aprovar', 'approve-join', { id: `${group.id}|${request.userId}`, cls: 'button button-outline button-small' })}</div>`).join('') || '<p class="quiet">Sem solicitações pendentes.</p>'}${group.members.map(member => `<div class="member-row">${avatar(userById(member.userId), 'avatar-comment')}<span>${esc(userById(member.userId).name)}</span><span class="member-role">${member.role === 'owner' ? 'Responsável' : member.role === 'moderator' ? 'Moderador' : 'Membro'}</span>${member.role !== 'owner' ? `<select data-member-role="${esc(group.id)}|${esc(member.userId)}" aria-label="Papel de ${esc(userById(member.userId).name)}"><option value="member" ${member.role === 'member' ? 'selected' : ''}>Membro</option><option value="moderator" ${member.role === 'moderator' ? 'selected' : ''}>Moderador</option></select>${action('Remover', 'remove-member', { id: `${group.id}|${member.userId}`, cls: 'text-action danger-text' })}` : ''}</div>`).join('')}</div>` : ''}
  </section>`;
}

function calendarView() {
  const events = [...state.events].sort((a, b) => a.date.localeCompare(b.date));
  return `<section class="card section-card"><div class="section-heading"><div><p class="eyebrow">AGENDA DA COMUNIDADE</p><h2>Datas importantes</h2><p>Organize entregas, avaliações e atividades escolares.</p></div>${action('＋ Adicionar data', 'add-event', { cls: 'button button-primary' })}</div>
    ${events.length ? `<div class="calendar-list">${events.map(event => `<article class="calendar-row"><time class="calendar-date" datetime="${esc(event.date)}"><b>${esc(event.date.slice(8))}</b><span>${new Date(`${event.date}T12:00:00`).toLocaleDateString('pt-BR', { month: 'short' })}</span></time><div class="calendar-copy"><span class="event-type">${esc(event.type)}</span><h3>${esc(event.title)}</h3><p>${esc(event.description || '')}</p></div><span class="calendar-year">${esc(event.date.slice(0, 4))}</span></article>`).join('')}</div>` : '<div class="empty-state"><h2>Sem datas cadastradas</h2><p>Adicione provas, trabalhos ou eventos da comunidade.</p></div>'}</section>
    <section class="card notice-card"><span class="shield-icon">i</span><p>Datas nesta versão são compartilhadas apenas neste navegador. A sincronização com a escola precisa de backend.</p></section>`;
}

function notificationsView() {
  const personal = state.groups.filter(group => canAccessGroup(group, currentUser().id)).flatMap(group => group.channels.flatMap(channel => channel.messages.filter(message => message.authorId !== currentUser().id && !message.readBy?.includes(currentUser().id)).map(message => ({ group, channel, message }))));
  return `<section class="card section-card"><div class="section-heading"><div><p class="eyebrow">CENTRAL DE ATIVIDADE</p><h2>Notificações recentes</h2><p>Avisos oficiais e mensagens não lidas dos seus grupos.</p></div>${action('Marcar tudo como lido', 'mark-all-read', { cls: 'button button-outline' })}</div>
    ${state.notices.map(notice => `<article class="notification-row"><span class="notification-icon official">✳</span><div><span class="eyebrow">AVISO OFICIAL</span><h3>${esc(notice.title)}</h3><p>${esc(notice.text)}</p><time>${new Date(notice.createdAt).toLocaleString('pt-BR')}</time></div></article>`).join('')}
    ${personal.map(({ group, channel, message }) => `<button class="notification-row notification-button" data-action="select-group" data-id="${esc(group.id)}"><span class="notification-icon">#</span><div><span class="eyebrow">${esc(group.name)} · #${esc(channel.name)}</span><h3>${esc(userById(message.authorId).name)} enviou uma mensagem</h3><p>${esc(message.text)}</p><time>${new Date(message.createdAt).toLocaleString('pt-BR')}</time></div><span class="new-dot" aria-label="Não lida"></span></button>`).join('')}
    ${state.groups.filter(group => canManageGroup(group, currentUser().id) || isStaff()).flatMap(group => group.joinRequests.map(request => `<article class="notification-row"><span class="notification-icon">◇</span><div><span class="eyebrow">SOLICITAÇÃO DE ENTRADA · ${esc(group.name)}</span><h3>${esc(userById(request.userId).name)} pediu acesso ao grupo</h3><p>A pessoa responsável pode aprovar ou rejeitar a solicitação.</p></div><button class="button button-outline button-small" data-action="select-group" data-id="${esc(group.id)}">Revisar</button></article>`)).join('')}
    ${!state.notices.length && !personal.length ? '<div class="empty-state"><span>✳</span><h2>Você está em dia</h2><p>Quando houver uma atualização importante, ela aparecerá aqui.</p></div>' : ''}</section>`;
}

function searchView() {
  const query = searchTerm.trim().toLocaleLowerCase('pt-BR');
  const posts = query ? visiblePosts().filter(post => post.text.toLocaleLowerCase('pt-BR').includes(query)) : [];
  const people = query ? state.users.filter(person => person.privacy?.discoverable !== false && !blockedUserIds().includes(person.id) && (person.name.toLocaleLowerCase('pt-BR').includes(query) || person.handle.toLowerCase().includes(query))) : [];
  const groups = query ? state.groups.filter(group => group.visibility === 'public' && (group.name.toLocaleLowerCase('pt-BR').includes(query) || group.description.toLocaleLowerCase('pt-BR').includes(query))) : [];
  return `<section class="card search-card"><p class="eyebrow">BUSCA NA COMUNIDADE</p><label for="community-search"><h2>O que você procura?</h2></label><div class="search-field"><span aria-hidden="true">⌕</span><input id="community-search" data-search-input placeholder="Pessoas, publicações ou grupos…" value="${esc(searchTerm)}" autocomplete="off"><kbd>Enter</kbd></div><p class="quiet">Resultados respeitam a visibilidade do perfil e dos grupos.</p></section>
    ${query ? `<section class="result-section"><div class="section-heading compact-heading"><div><h2>Pessoas <span class="result-count">${people.length}</span></h2></div></div>${people.length ? `<div class="card result-list">${people.map(person => `<article class="person-result">${avatar(person)}<div class="person-copy"><button class="identity-link" data-action="view-profile" data-id="${esc(person.id)}">${esc(person.name)} ${person.verified ? '<span class="verified-mark" role="img" aria-label="Selo demonstrativo" title="Selo de exemplo; identidade escolar não validada">✓</span>' : ''}</button><span>@${esc(person.handle)} · ${esc(roleLabels[person.role])}</span></div>${action('Ver perfil', 'view-profile', { id: person.id, cls: 'button button-outline button-small' })}${person.id !== currentUser().id ? action(blockedUserIds().includes(person.id) ? 'Desbloquear' : 'Bloquear', 'toggle-block', { id: person.id, cls: 'text-action' }) : ''}</article>`).join('')}</div>` : '<p class="quiet">Nenhuma pessoa encontrada.</p>'}</section>
    <section class="result-section"><div class="section-heading compact-heading"><div><h2>Grupos públicos <span class="result-count">${groups.length}</span></h2></div></div>${groups.length ? `<div class="card group-list">${groups.map(groupCard).join('')}</div>` : '<p class="quiet">Nenhum grupo público encontrado.</p>'}</section>
    <section class="result-section"><div class="section-heading compact-heading"><div><h2>Publicações <span class="result-count">${posts.length}</span></h2></div></div>${posts.length ? posts.map(postCard).join('') : '<p class="quiet">Nenhuma publicação encontrada.</p>'}</section>` : '<section class="card search-suggestions"><h2>Explore a comunidade</h2><div class="suggestion-row"><span>01</span><p>Encontre colegas pelo nome ou identificador.</p></div><div class="suggestion-row"><span>02</span><p>Busque projetos, temas e grupos públicos.</p></div><div class="suggestion-row"><span>03</span><p>Grupos privados não aparecem na busca.</p></div></section>'}`;
}

function profileView(userId) {
  const person = userById(userId);
  if (!person.id || (person.id !== currentUser().id && (person.privacy?.profileVisible === false || blockedUserIds().includes(person.id)))) return '<section class="card empty-state"><h2>Perfil indisponível</h2><p>Esta pessoa escolheu não exibir o perfil ou está bloqueada para você.</p></section>';
  const own = person.id === currentUser().id;
  const canSeeClass = own || person.privacy?.showClass;
  const canSeeSchool = own || person.privacy?.showSchool;
  const authored = state.posts.filter(post => post.authorId === person.id && !state.hiddenPostIds.includes(post.id) && !(own && hiddenPostIds().includes(post.id)));
  const authoredComments = state.posts.reduce((total, post) => total + post.comments.filter(comment => comment.authorId === person.id).length, 0);
  const visibleGroups = state.groups.filter(group => canAccessGroup(group, currentUser().id) && group.members.some(member => member.userId === person.id));
  const authoredMessages = visibleGroups.reduce((total, group) => total + group.channels.reduce((count, channel) => count + channel.messages.filter(message => message.authorId === person.id).length, 0), 0);
  const demoXp = authored.length * 20 + authoredComments * 5 + authoredMessages * 2 + visibleGroups.length * 10;
  return `<section class="profile-card card"><div class="profile-banner" style="${person.banner ? `background-image:linear-gradient(90deg,#122d20aa,#122d2010),url('${esc(person.banner)}')` : ''}" role="img" aria-label="Banner do perfil de ${esc(person.name)}"></div><div class="profile-heading">${avatar(person, 'avatar-profile')}<div class="profile-heading-copy"><h2>${esc(person.name)} ${person.verified ? '<span class="verified-mark" role="img" aria-label="Selo de verificação demonstrativo; serviço não conectado" title="Selo de exemplo; identidade escolar não validada" >✓</span>' : ''}</h2><span>@${esc(person.handle)}</span></div><div class="profile-controls">${own ? `${action('Editar perfil', 'edit-profile', { cls: 'button button-outline' })}${action('Preferências', 'go-settings', { cls: 'button button-outline' })}` : action(blockedUserIds().includes(person.id) ? 'Desbloquear' : 'Bloquear', 'toggle-block', { id: person.id, cls: 'button button-outline' })}</div></div><div class="profile-bio"><p>${esc(person.bio || 'Esta pessoa ainda não adicionou uma biografia.')}</p><div class="profile-facts">${canSeeClass && classLabel(person.classId) ? `<span>▦ ${esc(classLabel(person.classId))}</span>` : ''}${canSeeSchool && person.school ? `<span>⌂ ${esc(person.school)}</span>` : ''}<span>✳ Participante</span></div><div class="profile-stats"><div><b>${authored.length}</b><span>Publicações</span></div><div><b>${visibleGroups.length}</b><span>Grupos</span></div><div><b>${authored.reduce((sum, post) => sum + post.likes.length, 0)}</b><span>Reações</span></div><div><b>${demoXp}</b><span>XP demonstrativo</span></div></div><div class="achievement-strip"><span class="achievement-icon">✦</span><div><b>Participação na comunidade</b><span>Pontos e conquistas demonstrativos, sem ranking competitivo.</span></div><span class="pill-tag">${authored.length ? 'Ativo' : 'Começando'}</span></div></div></section>
    <div class="section-heading profile-post-heading"><div><p class="eyebrow">ATIVIDADE</p><h2>${own ? 'Suas publicações' : `Publicações de ${esc(person.name)}`}</h2></div></div>${authored.length ? authored.map(postCard).join('') : '<div class="card empty-inline">As publicações aparecerão aqui.</div>'}`;
}

function settingsView() {
  return `<section class="card section-card"><div class="section-heading"><div><p class="eyebrow">EXPERIÊNCIA</p><h2>Aparência e acessibilidade</h2><p>Ajustes salvos neste navegador e aplicados em todas as telas.</p></div></div>
    <div class="preference-row"><div><b>Tema</b><span>Escolha a aparência que prefere.</span></div><select data-pref="theme" aria-label="Tema"><option value="light" ${state.settings.theme === 'light' ? 'selected' : ''}>Claro</option><option value="dark" ${state.settings.theme === 'dark' ? 'selected' : ''}>Escuro</option></select></div>
    <div class="preference-row"><div><b>Tipo de fonte</b><span>Opção tipográfica para leitura confortável.</span></div><select data-pref="font" aria-label="Tipo de fonte"><option value="normal" ${state.settings.font === 'normal' ? 'selected' : ''}>Neutra</option><option value="dyslexic" ${state.settings.font === 'dyslexic' ? 'selected' : ''}>Atkinson Hyperlegible</option></select></div>
    <div class="preference-row range-row"><div><b>Tamanho do texto</b><span>Amplie ou reduza a tipografia.</span></div><input data-pref="textScale" type="range" min="90" max="140" step="5" value="${state.settings.textScale || 100}" aria-label="Tamanho do texto"><output>${state.settings.textScale || 100}%</output></div>
    ${[['highContrast', 'Alto contraste', 'Aumenta a separação entre textos, fundos e bordas.'], ['reduceMotion', 'Reduzir animações', 'Desativa movimentos e transições decorativas.'], ['reduceTransparency', 'Reduzir transparências e blur', 'Mantém superfícies opacas e nítidas.']].map(([key, title, help]) => `<div class="preference-row"><div><b>${title}</b><span>${help}</span></div><label class="switch"><input data-pref="${key}" type="checkbox" ${state.settings[key] ? 'checked' : ''}><span class="switch-track"></span><span class="visually-hidden">${title}</span></label></div>`).join('')}
  </section>
  <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">PRIVACIDADE</p><h2>Controle do seu perfil</h2><p>Escolha as informações exibidas a outras pessoas.</p></div></div>
    ${[['profileVisible', 'Perfil visível na comunidade'], ['showClass', 'Exibir turma no perfil'], ['showSchool', 'Exibir escola no perfil']].map(([key, title]) => `<div class="preference-row"><div><b>${title}</b><span>Controla a informação exibida no seu perfil.</span></div><label class="switch"><input data-pref-privacy="${key}" type="checkbox" ${currentUser().privacy?.[key] !== false ? 'checked' : ''}><span class="switch-track"></span><span class="visually-hidden">${title}</span></label></div>`).join('')}
    <div class="privacy-actions">${action('Ler aviso de privacidade', 'privacy', { cls: 'button button-outline' })}${action('Solicitar exclusão de conta', 'delete-request', { cls: 'button button-outline danger-text' })}${action('Apagar dados deste navegador', 'clear-data', { cls: 'button button-danger-outline' })}</div>
  </section>
  <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">PRÉVIA DO PRODUTO</p><h2>Visualizar permissões</h2><p>Seletor local para avaliar a interface dos perfis da escola. Não libera acesso real.</p></div></div><div class="preference-row"><div><b>Papel demonstrativo</b><span>Em produção, o backend determina as permissões.</span></div><select data-demo-role aria-label="Visualizar como papel"><option value="aluno" ${currentUser().role === 'aluno' ? 'selected' : ''}>Aluno</option><option value="professor" ${currentUser().role === 'professor' ? 'selected' : ''}>Professor</option><option value="secretaria" ${currentUser().role === 'secretaria' ? 'selected' : ''}>Secretaria</option><option value="administrador" ${currentUser().role === 'administrador' ? 'selected' : ''}>Administrador</option></select></div></section>
  <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">APENAS PARA TESTE</p><h2>Pessoas da demonstração</h2><p>Trocar de pessoa não autentica uma conta. Serve para testar privacidade, convites e entrada em grupos neste navegador.</p></div></div><div class="preference-row"><div><b>Visualizar como</b><span>Dados fictícios de exemplo.</span></div><select data-demo-user aria-label="Trocar pessoa da demonstração">${state.users.map(user => `<option value="${esc(user.id)}" ${user.id === currentUser().id ? 'selected' : ''}>${esc(user.name)}</option>`).join('')}</select></div>${isStaff() ? action('Abrir painel da equipe', 'go-admin', { cls: 'button button-outline' }) : ''}</section>
  <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">CONTROLE PESSOAL</p><h2>Pessoas bloqueadas</h2><p>Desbloqueie pessoas ocultadas no seu feed local.</p></div></div>${blockedUserIds().length ? blockedUserIds().map(userId => `<div class="member-row">${avatar(userById(userId), 'avatar-comment')}<span>${esc(userById(userId).name)}</span>${action('Desbloquear', 'toggle-block', { id: userId, cls: 'button button-outline button-small' })}</div>`).join('') : '<p class="quiet">Você ainda não bloqueou ninguém.</p>'}</section>
  <section class="card demo-data-card"><span class="shield-icon">◇</span><div><h2>Dados da demonstração</h2><p>Conteúdo e preferências ficam somente neste navegador. Senhas, tokens e códigos de autenticação nunca são salvos.</p></div>${action('Entrar ou cadastrar', 'auth', { cls: 'button button-outline' })}</section>`;
}

function adminView() {
  if (!isStaff()) return '<section class="card empty-state"><h2>Acesso não permitido</h2><p>Esta área é exibida apenas na prévia local para papéis da equipe.</p></section>';
  const flagged = state.posts.filter(post => post.moderation?.status === 'review');
  const flaggedMessages = state.groups.flatMap(group => group.channels.flatMap(channel => channel.messages.filter(message => message.moderation?.status === 'review').map(message => ({ group, channel, message }))));
  const pending = state.reports.filter(report => !['Resolvida', 'Rejeitada'].includes(report.status));
  const joinRequests = state.groups.flatMap(group => group.joinRequests.map(request => ({ group, request })));
  return `<section class="admin-stats">${[[state.users.length, 'Perfis locais'], [state.posts.length, 'Publicações'], [state.groups.length, 'Grupos'], [pending.length, 'Denúncias ativas']].map(([number, label]) => `<div class="stat-card card"><span>${label}</span><b>${number}</b></div>`).join('')}</section>
    <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">GRUPOS PRIVADOS</p><h2>Solicitações de entrada</h2><p>A equipe escolar pode revisar solicitações nesta prévia.</p></div></div>${joinRequests.map(({ group, request }) => `<article class="member-row">${avatar(userById(request.userId), 'avatar-comment')}<span>${esc(userById(request.userId).name)} · ${esc(group.name)}</span>${action('Aprovar', 'approve-join', { id: `${group.id}|${request.userId}`, cls: 'button button-outline button-small' })}</article>`).join('') || '<p class="quiet">Sem solicitações pendentes.</p>'}</section>
    <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">CUIDADO COM A COMUNIDADE</p><h2>Central de revisão</h2><p>Sinais automáticos orientam uma análise humana. Não determinam banimentos.</p></div><span class="review-pill">${flagged.length} para revisar</span></div>
      ${flagged.map(post => { const severe = post.moderation.signals.some(signal => signal.code === 'minor-safety'); return `<article class="review-row"><span class="review-symbol">${severe ? '!' : '◇'}</span><div class="review-copy"><span class="eyebrow">${severe ? 'PRIORIDADE ALTA · CONTEÚDO OCULTO' : 'REVISÃO HUMANA'}</span><h3>${esc(post.moderation.signals.map(signal => signal.label).join(' · '))}</h3><p>Publicação ${esc(post.id)} · por ${esc(userById(post.authorId).name)} · ${post.moderation.educationalContext ? 'contexto educativo detectado; avaliar contexto' : 'sinal automático, verificar contexto'}</p>${!severe ? `<blockquote>${esc(post.text.slice(0, 180))}${post.text.length > 180 ? '…' : ''}</blockquote>` : '<p>Texto e anexos não são exibidos nesta tela de revisão prioritária.</p>'}</div><div class="review-actions">${action('Resolvida', 'resolve-signal', { id: post.id, cls: 'button button-outline button-small' })}${action('Ocultar', 'hide-review', { id: post.id, cls: 'text-action danger-text' })}</div></article>`; }).join('') || '<div class="empty-inline">Nenhum conteúdo aguarda revisão.</div>'}
    </section>
    <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">MENSAGENS DE GRUPO</p><h2>Sinais para revisão</h2><p>Mensagens prioritárias não exibem o texto nesta tela.</p></div><span class="review-pill">${flaggedMessages.length}</span></div>${flaggedMessages.map(({ group, channel, message }) => { const severe = message.moderation.signals.some(signal => signal.code === 'minor-safety'); const ref = `${group.id}|${message.id}`; return `<article class="review-row"><span class="review-symbol">${severe ? '!' : '◇'}</span><div class="review-copy"><span class="eyebrow">${severe ? 'PRIORIDADE ALTA · CONTEÚDO OCULTO' : 'REVISÃO HUMANA'}</span><h3>${esc(message.moderation.signals.map(signal => signal.label).join(' · '))}</h3><p>${esc(group.name)} · #${esc(channel.name)} · ${esc(userById(message.authorId).name)}</p>${severe ? '<p>Texto e anexos não são exibidos nesta tela de revisão prioritária.</p>' : `<blockquote>${esc(message.text.slice(0, 180))}</blockquote>`}</div><div class="review-actions">${action('Resolvida', 'resolve-signal', { id: ref, cls: 'button button-outline button-small' })}${action('Ocultar', 'hide-review', { id: ref, cls: 'text-action danger-text' })}</div></article>`; }).join('') || '<p class="quiet">Nenhuma mensagem aguarda revisão.</p>'}</section>
    <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">MODERAÇÃO</p><h2>Denúncias recebidas</h2><p>Os detalhes enviados pelo autor ficam ocultos nesta visão geral.</p></div></div>
      ${state.reports.map(report => `<article class="report-row"><div class="report-icon">⚑</div><div class="report-copy"><h3>${esc(report.reason)}</h3><p>${esc(report.targetType)} · referência ${esc(report.targetId)} · ${new Date(report.createdAt).toLocaleString('pt-BR')}</p><span class="status-label status-${report.status.toLowerCase().replaceAll(' ', '-')}">${esc(report.status)}</span></div><select data-report-status="${esc(report.id)}" aria-label="Status da denúncia"><option ${report.status === 'Pendente' ? 'selected' : ''}>Pendente</option><option ${report.status === 'Em análise' ? 'selected' : ''}>Em análise</option><option ${report.status === 'Resolvida' ? 'selected' : ''}>Resolvida</option><option ${report.status === 'Rejeitada' ? 'selected' : ''}>Rejeitada</option></select>${action('Registrar', 'save-report-status', { id: report.id, cls: 'button button-outline button-small' })}</article>`).join('') || '<div class="empty-inline">Nenhuma denúncia registrada.</div>'}
    </section>
    <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">COMUNICAÇÃO</p><h2>Avisos oficiais</h2><p>Publicações da secretaria na versão local.</p></div>${action('＋ Novo aviso', 'add-notice', { cls: 'button button-primary' })}</div>${state.notices.map(notice => `<div class="notice-manage"><div><b>${esc(notice.title)}</b><p>${esc(notice.text)}</p></div>${action('Excluir', 'remove-notice', { id: notice.id, cls: 'text-action danger-text' })}</div>`).join('') || '<p class="quiet">Sem avisos.</p>'}</section>
    <section class="card section-card"><div class="section-heading"><div><p class="eyebrow">AUDITORIA LOCAL</p><h2>Histórico da equipe</h2></div></div>${state.audit.map(entry => `<div class="audit-row"><span>${esc(entry.message)}</span><time>${new Date(entry.createdAt).toLocaleString('pt-BR')}</time></div>`).join('') || '<p class="quiet">As ações administrativas registradas aparecerão aqui.</p>'}</section>
    <p class="admin-disclaimer">Painel demonstrativo. Em produção, validar cada ação e permissão no servidor; ocultar opções na interface não é controle de segurança.</p>`;
}

function applyPreferences() {
  const settings = state.settings;
  document.body.classList.toggle('dark-theme', settings.theme === 'dark');
  document.body.classList.toggle('dyslexic-font', settings.font === 'dyslexic');
  document.body.classList.toggle('high-contrast', Boolean(settings.highContrast));
  document.body.classList.toggle('reduce-motion', Boolean(settings.reduceMotion));
  document.body.classList.toggle('reduce-transparency', Boolean(settings.reduceTransparency));
  document.documentElement.style.setProperty('--text-scale', `${settings.textScale || 100}%`);
}

function openDialog(title, html, { labelled = true } = {}) {
  dialogBody.innerHTML = `${labelled ? `<h2 id="dialog-title">${esc(title)}</h2>` : ''}${html}`;
  dialog.setAttribute('aria-labelledby', labelled ? 'dialog-title' : 'dialog-fallback-title');
  if (!dialog.open) dialog.showModal();
  const focusTarget = dialog.querySelector('input:not([type="hidden"]),textarea,select,button:not(.close)');
  focusTarget?.focus({ preventScroll: true });
}

function dialogForm(title, formType, fields, submitText = 'Salvar', data = {}) {
  dialogBody.innerHTML = `<h2 id="dialog-title">${esc(title)}</h2><form id="modal-form" data-form="${esc(formType)}" ${Object.entries(data).map(([key, value]) => `data-${key}="${esc(value)}"`).join(' ')}>${fields}<div class="dialog-actions"><button type="button" class="button button-outline" data-action="close-dialog">Cancelar</button><button type="submit" class="button button-primary">${submitText}</button></div></form>`;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('input:not([type="hidden"]),textarea,select')?.focus({ preventScroll: true });
}

function field(label, name, { type = 'text', value = '', required = false, max = '', hint = '', attrs = '' } = {}) {
  const inputId = `field-${name}`;
  return `<div class="form-field"><label for="${inputId}">${label}${required ? ' <span aria-hidden="true">*</span>' : ''}</label>${type === 'textarea' ? `<textarea id="${inputId}" name="${name}" ${required ? 'required' : ''} ${max ? `maxlength="${max}"` : ''} ${attrs}>${esc(value)}</textarea>` : `<input id="${inputId}" name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${max ? `maxlength="${max}"` : ''} ${attrs}>`}${hint ? `<small>${hint}</small>` : ''}</div>`;
}

function showPrivacy() {
  const privacyText = firebaseMode
    ? '<p>Esta sessão usa Firebase Auth, Firestore e Storage configurados pelo projeto escolar. A escola ainda precisa definir finalidades, retenção, responsáveis, direitos e procedimentos para dados de crianças e adolescentes.</p><h3>Dados e acesso</h3><p>O perfil público contém somente informações autorizadas nas preferências; grupos privados e mensagens são verificados pelas regras do Firestore. A exclusão de conta e retenção de conteúdo precisam seguir o procedimento institucional.</p><h3>Limites</h3><p>O aviso não comprova conformidade completa com a LGPD. Antes do uso real, revise políticas, funções, regras, backups, retenção, consentimentos aplicáveis e testes de acesso.</p>'
    : '<p>Esta versão demonstra uma comunidade escolar. O conteúdo de exemplo e o que você cria ficam no armazenamento local deste navegador.</p><h3>O que esta prévia guarda</h3><ul><li>Publicações, comentários, grupos e mensagens locais.</li><li>Preferências de aparência e informações de perfil da demonstração.</li><li>Imagens de prévia selecionadas, limitadas a 1,2 MB.</li></ul><h3>O que ainda não está conectado</h3><p>Não há autenticação, banco, envio de denúncias, sincronização ou armazenamento de mídia em servidor. Evite dados pessoais reais e, em especial, dados de crianças e adolescentes.</p><p>A tela não representa conformidade completa com a LGPD. Uma operação real requer definição de finalidade, base legal, retenção, direitos, responsáveis, proteção apropriada e procedimentos de segurança.</p><p>Você pode apagar o conteúdo demonstrativo em Preferências. A exclusão local não é um pedido enviado à escola.</p>';
  openDialog('Privacidade no CONecta V2', `<div class="privacy-copy">${privacyText}</div><div class="dialog-actions"><button class="button button-primary" data-action="close-dialog">Entendi</button></div>`);
}

function communityRules() {
  openDialog('Acordos da comunidade', `<div class="privacy-copy"><p>O CONecta é um espaço de convivência escolar. Ajude a manter um ambiente respeitoso:</p><ul><li>Converse sobre ideias sem atacar pessoas ou grupos.</li><li>Não publique dados privados seus ou de outras pessoas.</li><li>Não compartilhe conteúdo íntimo, ameaças, perseguição ou material ilegal.</li><li>Use Denunciar quando algo parecer inseguro. Denúncias nesta versão ficam apenas neste navegador.</li><li>Discussões históricas e educativas devem ser avaliadas pelo contexto; sinais automáticos não decidem punições.</li></ul></div><div class="dialog-actions"><button class="button button-primary" data-action="close-dialog">Fechar</button></div>`);
}

function reportDialog(type, targetId) {
  dialogForm('Denunciar conteúdo', 'report', `<p class="quiet">Referência: ${esc(type)} ${esc(targetId)}. Não anexe imagens íntimas nem material ilegal.</p><input type="hidden" name="targetType" value="${esc(type)}"><input type="hidden" name="targetId" value="${esc(targetId)}"><div class="form-field"><label for="report-reason">Motivo *</label><select id="report-reason" name="reason" required><option value="">Selecione um motivo</option><option>Assédio, ameaça ou perseguição</option><option>Racismo ou discurso de ódio</option><option>Spam, fraude ou tentativa de burlar filtros</option><option>Risco envolvendo criança ou adolescente</option><option>Incentivo à violência ou propaganda extremista</option><option>Outro</option></select></div>${field('Detalhes (opcional)', 'details', { type: 'textarea', max: 600, hint: 'Não inclua nomes completos, endereços, imagens ou descrições explícitas.' })}<p class="safety-note">Registro local demonstrativo. Casos graves exigem revisão autorizada e proteção adequada no servidor.</p>`, 'Enviar denúncia');
}

function authDialog(mode = 'login') {
  authMode = mode;
  const modeLabel = { login: 'Entrar', signup: 'Criar conta', recovery: 'Recuperar acesso', email: 'Confirmar e-mail', twofactor: 'Verificação em duas etapas' }[mode];
  const personFields = mode === 'signup' ? field('Nome completo', 'name', { required: true, max: 70, attrs: 'autocomplete="name" minlength="5"', hint: 'Use seu nome verdadeiro; não use números ou sequências aleatórias.' }) : '';
  const passwordField = ['login', 'signup'].includes(mode) ? field('Senha', 'password', { type: 'password', required: true, attrs: `autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" minlength="8"`, hint: 'A senha não será salva nesta demonstração.' }) : '';
  const codeField = mode === 'twofactor' ? field('Código de autenticação', 'code', { required: true, max: 8, attrs: 'inputmode="numeric" autocomplete="one-time-code"' }) : '';
  const authStatus = firebaseMode ? '<b>Firebase Auth</b><span>E-mail e senha são verificados pelo Firebase. A confirmação da conta usa um link enviado por e-mail.</span>' : '<b>Demonstração local</b><span>O login, cadastro, recuperação e 2FA não estão conectados a um serviço real.</span>';
  dialogBody.innerHTML = `<div class="auth-heading"><span class="brand-symbol">C</span><p class="eyebrow">CONecta V2 · CONTA</p><h2 id="dialog-title">${modeLabel}</h2><p>${firebaseMode ? 'A autenticação é processada pelo Firebase Auth.' : 'Interface de autenticação preparada para serviço futuro.'}</p></div><div class="demo-callout">${authStatus}</div><div role="tablist" aria-label="Fluxos de conta" class="auth-tabs">${[['login', 'Entrar'], ['signup', 'Cadastrar'], ['recovery', 'Recuperar'], ['email', 'Reenviar e-mail'], ['twofactor', '2FA']].map(([key, label]) => `<button type="button" role="tab" aria-selected="${mode === key}" data-auth-mode="${key}" class="${mode === key ? 'selected' : ''}">${label}</button>`).join('')}</div><form id="auth-form" data-form="auth" data-mode="${mode}">${mode !== 'twofactor' ? field('E-mail escolar', 'email', { type: 'email', required: mode !== 'email', attrs: 'autocomplete="email"' }) : ''}${personFields}${passwordField}${codeField}<p id="auth-message" class="auth-message" aria-live="polite">${mode === 'email' ? 'O Firebase envia um link de confirmação, não um código numérico.' : mode === 'twofactor' ? '2FA ainda requer configurar telefone e reCAPTCHA no Firebase Console.' : firebaseMode ? 'Preencha os campos para continuar.' : 'Nenhuma credencial será enviada nesta demonstração.'}</p><div class="dialog-actions"><button type="button" class="button button-outline" data-action="close-dialog">Cancelar</button><button class="button button-primary" type="submit">${mode === 'recovery' ? 'Solicitar recuperação' : mode === 'email' ? 'Reenviar confirmação' : mode === 'twofactor' ? 'Verificar código' : mode === 'signup' ? 'Criar conta' : 'Entrar'}</button></div></form><p class="auth-legal">Papéis escolares e permissões são validados no backend Firebase. <button data-action="privacy" class="text-action">Aviso de privacidade</button></p>`;
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('input')?.focus({ preventScroll: true });
}

function createPost(form) {
  const values = new FormData(form);
  const text = String(values.get('text') || '').trim();
  if (!text) return;
  const moderation = reviewSignals(text);
  if (moderation.blockPreview) {
    toast('Publicação retida nesta prévia por um sinal de risco grave. Nenhum anexo foi enviado; a revisão real exige fluxo protegido no servidor.');
    return;
  }
  const file = values.get('image');
  const add = async () => {
    let image = '';
    if (file?.size) {
      try { image = firebaseMode ? await FirebaseRepository.uploadImage(file, 'post', currentUser().id) : await StorageAdapter.image(file); }
      catch (error) { toast(error.message); return; }
    }
    state.posts.unshift({ id: id('post'), authorId: currentUser().id, text, image, imageAlt: String(values.get('imageAlt') || '').trim(), createdAt: Date.now(), updatedAt: Date.now(), likes: [], comments: [], moderation });
    save();
    toast(moderation.status === 'review' ? 'Publicação criada e sinalizada para revisão humana.' : 'Publicação criada.');
  };
  add();
}

function addAudit(message) {
  state.audit.unshift({ id: id('audit'), message, actorId: currentUser().id, createdAt: Date.now() });
  state.audit = state.audit.slice(0, 80);
}

function renderPostMenu(post) {
  const own = post.authorId === currentUser().id;
  openDialog('Opções da publicação', `<div class="menu-options">${own ? `${action('Editar publicação', 'edit-post', { id: post.id, cls: 'menu-option' })}${action('Excluir publicação', 'delete-post', { id: post.id, cls: 'menu-option danger-text' })}` : ''}${action('Denunciar', 'report-post', { id: post.id, cls: 'menu-option' })}${action('Ocultar publicação para mim', 'hide-post', { id: post.id, cls: 'menu-option' })}${!own ? action(blockedUserIds().includes(post.authorId) ? 'Desbloquear pessoa' : 'Bloquear pessoa', 'toggle-block', { id: post.authorId, cls: 'menu-option danger-text' }) : ''}</div>`);
}

function handleAction(button) {
  const name = button.dataset.action;
  const itemId = button.dataset.id;
  const post = state.posts.find(item => item.id === itemId);
  switch (name) {
    case 'go-calendar': setRoute('calendar'); render(); break;
    case 'privacy': showPrivacy(); break;
    case 'community-rules': communityRules(); break;
    case 'close-dialog': dialog.close(); break;
    case 'account-menu': openDialog(firebaseMode ? 'Sua conta CONecta' : 'Sua conta demonstrativa', `<p class="quiet">${esc(currentUser().name)} · ${esc(roleLabels[currentUser().role])}</p><div class="menu-options">${action('Ver perfil', 'view-profile', { id: currentUser().id, cls: 'menu-option' })}${action('Preferências', 'go-settings', { cls: 'menu-option' })}${firebaseMode ? action('Sair da conta', 'sign-out', { cls: 'menu-option danger-text' }) : action('Entrar / cadastrar', 'auth', { cls: 'menu-option' })}</div>`); break;
    case 'go-settings': setRoute('settings'); dialog.close(); render(); break;
    case 'go-admin': setRoute(isStaff() ? 'admin' : 'feed'); dialog.close(); render(); break;
    case 'auth': authDialog(); break;
    case 'auth-signup': authDialog('signup'); break;
    case 'sign-out': if (firebaseMode) FirebaseAuthAdapter.request({ mode: 'signout' }).catch(error => toast(error.message)); break;
    case 'resend-verification': FirebaseAuthAdapter.request({ mode: 'email' }).then(result => toast(result.message)).catch(error => toast(error.message)); break;
    case 'reload-auth': FirebaseAuthAdapter.request({ mode: 'reload' }).then(() => onFirebaseUser(firebaseUser)).catch(error => toast(error.message)); break;
    case 'view-profile': setRoute('profile', { userId: itemId }); dialog.close(); render(); window.scrollTo(0, 0); break;
    case 'like': if (post) { post.likes = post.likes.includes(currentUser().id) ? post.likes.filter(userId => userId !== currentUser().id) : [...post.likes, currentUser().id]; save(); } break;
    case 'focus-comment': document.querySelector(`#comment-${CSS.escape(itemId)}`)?.focus(); break;
    case 'report-post': reportDialog('publicação', itemId); break;
    case 'report-message': reportDialog('mensagem', itemId); break;
    case 'post-menu': if (post) renderPostMenu(post); break;
    case 'edit-post': if (post?.authorId === currentUser().id) { dialog.close(); dialogForm('Editar publicação', 'edit-post', `<input type="hidden" name="id" value="${esc(post.id)}">${field('Texto da publicação', 'text', { type: 'textarea', value: post.text, max: 1500, required: true })}`, 'Salvar alterações'); } break;
    case 'delete-post': if (post?.authorId === currentUser().id && confirm('Excluir esta publicação da demonstração?')) { state.posts = state.posts.filter(item => item.id !== post.id); dialog.close(); save(); toast('Publicação excluída.'); } break;
    case 'hide-post': { const hidden = hiddenPostIds(); if (!hidden.includes(itemId)) state.hiddenPostIdsByUser[currentUser().id] = [...hidden, itemId]; dialog.close(); save(); toast('Publicação ocultada no seu feed local.'); break; }
    case 'toggle-block': toggleBlock(itemId); break;
    case 'create-group': createGroupDialog(); break;
    case 'select-group': openGroup(itemId); break;
    case 'select-channel': setRoute('groups', { groupId: currentGroup()?.id || '', channelId: itemId }); markChannelRead(currentGroup(), currentChannel(currentGroup())); save(); break;
    case 'join-public': joinPublic(itemId); break;
    case 'request-join': requestJoin(itemId); break;
    case 'leave-group': leaveGroup(itemId); break;
    case 'group-menu': groupMenu(itemId); break;
    case 'issue-invite': issueInvite(itemId); break;
    case 'enter-invite': dialogForm('Entrar com código de convite', 'accept-invite', `${field('Código de convite', 'code', { required: true, max: 12, attrs: 'autocomplete="off"' })}<p class="quiet">Os códigos da prévia são temporários e existem apenas enquanto esta página está aberta.</p>`, 'Validar código'); break;
    case 'add-channel': if (canManageGroup(currentGroup(), currentUser().id)) dialogForm('Adicionar canal', 'add-channel', `${field('Nome do canal', 'name', { required: true, max: 40 })}${field('Categoria', 'category', { value: 'Geral', max: 40 })}`); break;
    case 'report-group': reportDialog('grupo', itemId); break;
    case 'approve-join': approveJoin(itemId); break;
    case 'remove-member': removeMember(itemId); break;
    case 'add-event': dialogForm('Adicionar data escolar', 'add-event', `${field('Título', 'title', { required: true, max: 100 })}${field('Data', 'date', { type: 'date', required: true })}<div class="form-field"><label for="event-type">Tipo</label><select name="type" id="event-type"><option>Prova</option><option>Trabalho</option><option>Evento</option></select></div>${field('Descrição', 'description', { type: 'textarea', max: 300 })}`); break;
    case 'mark-all-read': markAllRead(); break;
    case 'edit-profile': editProfileDialog(); break;
    case 'add-notice': if (isStaff()) dialogForm('Novo aviso oficial', 'add-notice', `${field('Título', 'title', { required: true, max: 100 })}${field('Mensagem', 'text', { type: 'textarea', required: true, max: 600 })}`); break;
    case 'remove-notice': if (isStaff()) { state.notices = state.notices.filter(notice => notice.id !== itemId); addAudit('Aviso oficial removido'); save(); } break;
    case 'save-report-status': updateReport(itemId); break;
    case 'resolve-signal': if (isStaff()) { if (itemId.includes('|')) { const [groupId, messageId] = itemId.split('|'); const message = state.groups.find(group => group.id === groupId)?.channels.flatMap(channel => channel.messages).find(entry => entry.id === messageId); if (message) message.moderation.status = 'reviewed'; } else { const target = state.posts.find(item => item.id === itemId); if (target) target.moderation.status = 'reviewed'; } addAudit(`Sinal revisado: ${itemId}`); save(); toast('Revisão registrada.'); } break;
    case 'hide-review': if (isStaff()) { if (itemId.includes('|')) { const [groupId, messageId] = itemId.split('|'); const message = state.groups.find(group => group.id === groupId)?.channels.flatMap(channel => channel.messages).find(entry => entry.id === messageId); if (message) message.moderation.status = 'hidden'; if (!state.hiddenMessageIds.includes(itemId)) state.hiddenMessageIds.push(itemId); } else { const target = state.posts.find(item => item.id === itemId); if (target) target.moderation.status = 'hidden'; if (!state.hiddenPostIds.includes(itemId)) state.hiddenPostIds.push(itemId); } addAudit(`Conteúdo ${itemId} ocultado após revisão`); save(); toast('Conteúdo ocultado na demonstração.'); } break;
    case 'delete-request': openDialog('Solicitação de exclusão', `<p>Este botão apenas mostra o procedimento. Nenhuma solicitação foi transmitida.</p><p>Uma versão conectada deve confirmar a identidade, tratar dados de crianças e adolescentes e acompanhar o pedido até sua conclusão.</p><div class="dialog-actions"><button class="button button-primary" data-action="close-dialog">Fechar</button></div>`); break;
    case 'clear-data': openDialog('Apagar dados locais?', `<p>Isso restaura o conteúdo de exemplo e remove alterações feitas neste navegador.</p><div class="dialog-actions"><button class="button button-outline" data-action="close-dialog">Cancelar</button><button class="button button-danger-outline" data-action="confirm-clear">Apagar dados</button></div>`); break;
    case 'confirm-clear': state = DemoRepository.reset(); pendingInviteCodes.clear(); selectedGroupId = ''; dialog.close(); save(); toast('Dados locais restaurados.'); break;
    default: break;
  }
}

function createGroupDialog() {
  dialogForm('Criar um grupo', 'create-group', `${field('Nome do grupo', 'name', { required: true, max: 70 })}${field('Descrição', 'description', { required: true, max: 180 })}<div class="form-field"><label for="group-visibility">Visibilidade</label><select id="group-visibility" name="visibility"><option value="public">Público · aparece na descoberta</option><option value="private">Privado · acesso por convite</option></select></div><div class="form-field"><label for="group-category">Categoria</label><select id="group-category" name="category"><option>Turmas</option><option>Projetos</option><option>Interesses</option><option>Estudos</option><option>Comunidade</option></select></div>${field('Regras de convivência', 'rules', { type: 'textarea', max: 400, value: 'Convivência respeitosa. Não compartilhe dados pessoais.' })}`, 'Criar grupo');
}

function editProfileDialog() {
  const user = currentUser();
  dialogForm('Editar perfil', 'edit-profile', `${field('Nome de exibição', 'name', { value: user.name, required: true, max: 70, hint: 'Use um nome plausível, sem números ou sequências aleatórias.' })}${field('Biografia', 'bio', { type: 'textarea', value: user.bio, max: 240 })}<div class="form-field"><label for="profile-class">Turma (opcional)</label><select name="classId" id="profile-class"><option value="">Não exibir turma</option><optgroup label="Ensino regular">${classCatalog.regular.map(item => `<option value="${item.id}" ${item.id === user.classId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</optgroup><optgroup label="Ensino técnico">${classCatalog.technical.map(item => `<option value="${item.id}" ${item.id === user.classId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</optgroup></select></div>${field('Foto de perfil', 'avatar', { type: 'file', attrs: 'accept="image/*"' })}${field('Banner do perfil', 'banner', { type: 'file', attrs: 'accept="image/*"' })}<p class="quiet">${firebaseMode ? 'Imagens enviadas ao Firebase Storage.' : 'Imagens ficam como prévia local nesta demonstração.'}</p>`, 'Salvar perfil');
}

function groupMenu(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group || !canAccessGroup(group, currentUser().id)) return toast('Acesso não permitido.');
  openDialog('Opções do grupo', `<div class="menu-options">${action('Ver regras', 'show-group-rules', { id: group.id, cls: 'menu-option' })}${action('Denunciar grupo', 'report-group', { id: group.id, cls: 'menu-option' })}${action('Convidar alguém', 'issue-invite', { id: group.id, cls: 'menu-option' })}${action('Sair do grupo', 'leave-group', { id: group.id, cls: 'menu-option danger-text' })}</div>`);
}

function handleGroupAccess(group, operation) {
  if (!canAccessGroup(group, currentUser().id)) {
    toast('Acesso negado. Este grupo é privado ou você não participa mais dele.');
    if (selectedGroupId === group?.id) selectedGroupId = '';
    render();
    return false;
  }
  return true;
}

function openGroup(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!handleGroupAccess(group, 'open')) return;
  setRoute('groups', { groupId, channelId: group.channels[0]?.id || '' });
  markChannelRead(group, currentChannel(group));
  save();
  window.scrollTo(0, 0);
}

function markChannelRead(group, channel) {
  if (!group || !channel || !canAccessGroup(group, currentUser().id)) return;
  channel.messages.forEach(message => { message.readBy ||= []; if (!message.readBy.includes(currentUser().id)) message.readBy.push(currentUser().id); });
}

function joinPublic(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group || group.visibility !== 'public') return toast('Este grupo não está disponível para descoberta.');
  if (!group.members.some(member => member.userId === currentUser().id)) group.members.push({ userId: currentUser().id, role: 'member', joinedAt: Date.now() });
  selectedGroupId = group.id;
  selectedChannelId = group.channels[0]?.id || '';
  addAudit(`Entrou no grupo público ${group.name}`);
  save();
  toast('Você entrou no grupo.');
}

function requestJoin(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!group || group.visibility !== 'private') return toast('Solicitações só se aplicam a grupos privados.');
  if (canAccessGroup(group, currentUser().id)) return toast('Você já participa deste grupo.');
  if (!group.joinRequests.some(request => request.userId === currentUser().id)) group.joinRequests.push({ userId: currentUser().id, createdAt: Date.now(), status: 'Pendente' });
  save();
  toast('Solicitação registrada. A pessoa responsável precisa aprovar a entrada.');
}

function leaveGroup(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!handleGroupAccess(group, 'leave')) return;
  if (groupRole(group, currentUser().id) === 'owner') return toast('Transfira a responsabilidade antes de sair do grupo.');
  if (!confirm(`Sair do grupo “${group.name}”?`)) return;
  group.members = group.members.filter(member => member.userId !== currentUser().id);
  group.joinRequests = group.joinRequests.filter(request => request.userId !== currentUser().id);
  selectedGroupId = '';
  addAudit(`Saiu do grupo ${group.name}`);
  save();
  toast('Você saiu do grupo.');
}

async function issueInvite(groupId) {
  const group = state.groups.find(item => item.id === groupId);
  if (!handleGroupAccess(group, 'invite') || !canManageGroup(group, currentUser().id)) return toast('Somente responsáveis pelo grupo podem criar convites.');
  if (firebaseMode) {
    try {
      const invite = await FirebaseRepository.createInvite(groupId);
      openDialog('Convite seguro para grupo privado', `<p>Compartilhe este código com uma pessoa de confiança. Ele expira em 10 minutos e é validado pelo backend Firebase.</p><div class="invite-code">${esc(invite.code)}</div><p class="safety-note">Não publique o código em espaços abertos. A entrada será autorizada pelo servidor.</p><div class="dialog-actions"><button class="button button-primary" data-action="close-dialog">Fechar</button></div>`);
    } catch (error) { toast(error.message); }
    return;
  }
  const code = crypto.randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  pendingInviteCodes.set(code, { groupId, expiresAt: Date.now() + 10 * 60 * 1000 });
  openDialog('Convite temporário', `<p>Compartilhe este código com uma pessoa de confiança. Ele expira em 10 minutos e existe apenas enquanto esta prévia estiver aberta.</p><div class="invite-code">${code}</div><p class="safety-note">Este código demonstrativo não é uma proteção de backend e não fica salvo após atualizar a página.</p><div class="dialog-actions"><button class="button button-primary" data-action="close-dialog">Fechar</button></div>`);
}

function approveJoin(compositeId) {
  const [groupId, userId] = compositeId.split('|');
  const group = state.groups.find(item => item.id === groupId);
  if (!group || (!canManageGroup(group, currentUser().id) && !isStaff())) return toast('Você não pode aprovar membros neste grupo.');
  if (!group.joinRequests.some(request => request.userId === userId)) return toast('A solicitação já não está pendente.');
  group.joinRequests = group.joinRequests.filter(request => request.userId !== userId);
  group.members.push({ userId, role: 'member', joinedAt: Date.now() });
  addAudit(`Solicitação de entrada aprovada no grupo ${group.name}`);
  save();
}

function removeMember(compositeId) {
  const [groupId, userId] = compositeId.split('|');
  const group = state.groups.find(item => item.id === groupId);
  if (!group || !canManageGroup(group, currentUser().id) || group.ownerId === userId) return toast('Esta ação não está permitida.');
  group.members = group.members.filter(member => member.userId !== userId);
  addAudit(`Membro removido do grupo ${group.name}`);
  save();
}

function toggleBlock(userId) {
  if (!userId || userId === currentUser().id) return;
  const blocked = blockedUserIds();
  state.blockedUserIdsByUser[currentUser().id] = blocked.includes(userId) ? blocked.filter(idValue => idValue !== userId) : [...blocked, userId];
  dialog.close();
  save();
  toast(blockedUserIds().includes(userId) ? 'Pessoa bloqueada nesta demonstração.' : 'Pessoa desbloqueada.');
}

function markAllRead() {
  state.groups.filter(group => canAccessGroup(group, currentUser().id)).forEach(group => group.channels.forEach(channel => markChannelRead(group, channel)));
  save();
  toast('Mensagens marcadas como lidas.');
}

function updateReport(reportId) {
  if (!isStaff()) return toast('Ação reservada à equipe.');
  const report = state.reports.find(item => item.id === reportId);
  const select = document.querySelector(`[data-report-status="${CSS.escape(reportId)}"]`);
  if (!report || !select) return;
  report.status = select.value;
  addAudit(`Denúncia ${reportId} atualizada para ${report.status}`);
  save();
  toast('Atualização registrada no histórico local.');
}

async function submitAuth(form) {
  const mode = form.dataset.mode;
  const values = new FormData(form);
  const message = document.querySelector('#auth-message');
  const email = String(values.get('email') || '').trim().toLowerCase();
  if (mode === 'signup') {
    const name = String(values.get('name') || '').trim();
    const plausible = /^[\p{L}]+(?:[ '\-][\p{L}]+){1,5}$/u.test(name);
    const normalized = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
    if (!plausible) { message.textContent = 'Informe um nome plausível, sem números ou sequências aleatórias.'; message.classList.add('error'); return; }
    if (!firebaseMode && state.users.some(user => normalized(user.name) === normalized(name) || user.handle.toLowerCase() === email.split('@')[0])) { message.textContent = 'Este nome ou identificador já existe nesta demonstração. A duplicidade real deve ser confirmada no servidor.'; message.classList.add('error'); return; }
  }
  if (['login', 'signup', 'recovery'].includes(mode) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { message.textContent = 'Confira o formato do e-mail.'; message.classList.add('error'); return; }
  message.classList.remove('error');
  if (mode === 'twofactor' && !/^\d{4,8}$/.test(String(values.get('code') || ''))) { message.textContent = 'Digite um código de 4 a 8 números.'; message.classList.add('error'); return; }
  if (!firebaseMode) {
    await AuthAdapter.request();
    message.textContent = 'Demonstração: o serviço ainda não está conectado. Nenhum login, cadastro, recuperação ou código foi enviado e nenhuma sessão foi criada.';
    return;
  }
  try {
    const result = await FirebaseAuthAdapter.request({ mode, email, password: String(values.get('password') || ''), name: String(values.get('name') || '').trim() });
    message.textContent = result.message || 'Solicitação concluída.';
  } catch (error) { message.textContent = error.message; message.classList.add('error'); }
}

function handleDialogAction(button) {
  if (button.dataset.authMode) { authDialog(button.dataset.authMode); return; }
  if (button.dataset.action === 'show-group-rules') {
    const group = state.groups.find(item => item.id === button.dataset.id);
    if (group && handleGroupAccess(group, 'rules')) openDialog(`Regras · ${group.name}`, `<p>${esc(group.rules)}</p><div class="dialog-actions"><button class="button button-primary" data-action="close-dialog">Fechar</button></div>`);
    return;
  }
  handleAction(button);
}

async function submitForm(form) {
  const type = form.dataset.form;
  const values = new FormData(form);
  if (type === 'post') return createPost(form);
  if (type === 'comment') {
    const post = state.posts.find(item => item.id === form.dataset.id);
    if (!post || blockedUserIds().includes(post.authorId)) return toast('Você não pode comentar nesta publicação.');
    const text = String(values.get('text') || '').trim();
    if (text) { post.comments.push({ id: id('comment'), authorId: currentUser().id, text, createdAt: Date.now() }); save(); }
    return;
  }
  if (type === 'message') {
    const group = state.groups.find(item => item.id === form.dataset.group);
    const channel = group?.channels.find(item => item.id === form.dataset.channel);
    if (!handleGroupAccess(group, 'message') || !channel) return;
    if (firebaseMode && !group.members.some(member => member.userId === currentUser().id)) return toast('Entre no grupo antes de enviar mensagens.');
    const text = String(values.get('text') || '').trim();
    if (!text) return;
    const signal = reviewSignals(text);
    if (signal.blockPreview) return toast('A mensagem foi retida nesta prévia por um sinal de risco grave.');
    channel.messages.push({ id: id('message'), authorId: currentUser().id, text, createdAt: Date.now(), readBy: [currentUser().id], moderation: signal });
    save();
    return;
  }
  if (type === 'auth') return submitAuth(form);
  if (type === 'report') {
    const targetType = String(values.get('targetType'));
    const targetId = String(values.get('targetId'));
    const reason = String(values.get('reason') || 'Outro');
    const details = String(values.get('details') || '').trim();
    const severity = reason.includes('criança') || reason.includes('adolescente');
    if (targetType === 'publicação' && !state.posts.some(item => item.id === targetId)) return toast('A publicação denunciada não está disponível.');
    if (targetType === 'grupo') {
      const group = state.groups.find(item => item.id === targetId);
      if (!group || !canAccessGroup(group, currentUser().id)) return toast('O grupo denunciado não está disponível para sua conta.');
    }
    if (targetType === 'mensagem') {
      const [groupId, messageId] = targetId.split('|');
      const group = state.groups.find(item => item.id === groupId);
      const message = group?.channels.flatMap(channel => channel.messages).find(item => item.id === messageId);
      if (!group || !message || !canAccessGroup(group, currentUser().id)) return toast('A mensagem denunciada não está disponível para sua conta.');
      if (severity) {
        if (!state.hiddenMessageIds.includes(targetId)) state.hiddenMessageIds.push(targetId);
        message.moderation = { status: 'review', signals: [{ code: 'minor-safety', label: 'Denúncia de risco envolvendo menor', priority: 'urgent' }], educationalContext: false, blockPreview: true };
      }
    }
    if (severity && targetType === 'publicação') {
      if (!state.hiddenPostIds.includes(targetId)) state.hiddenPostIds.push(targetId);
      const target = state.posts.find(item => item.id === targetId);
      if (target) target.moderation = { status: 'review', signals: [{ code: 'minor-safety', label: 'Denúncia de risco envolvendo menor', priority: 'urgent' }], educationalContext: false, blockPreview: true };
    }
    state.reports.unshift({ id: id('report'), authorId: currentUser().id, targetType, targetId, reason, details: details.slice(0, 600), severity, status: 'Pendente', createdAt: Date.now() });
    dialog.close();
    save();
    toast('Denúncia registrada localmente. Nenhum serviço externo recebeu o relato.');
    return;
  }
  if (type === 'edit-post') {
    const post = state.posts.find(item => item.id === values.get('id'));
    if (post?.authorId !== currentUser().id) return toast('Você só pode editar suas publicações.');
    const text = String(values.get('text') || '').trim();
    const review = reviewSignals(text);
    if (review.blockPreview) return toast('A alteração foi retida por um sinal de risco grave.');
    post.text = text; post.updatedAt = Date.now(); post.moderation = review;
    dialog.close(); save(); toast('Publicação atualizada.'); return;
  }
  if (type === 'create-group') {
    const group = { id: id('group'), name: String(values.get('name')).trim(), description: String(values.get('description')).trim(), visibility: String(values.get('visibility')), category: String(values.get('category')), ownerId: currentUser().id, rules: String(values.get('rules') || '').trim(), members: [{ userId: currentUser().id, role: 'owner', joinedAt: Date.now() }], joinRequests: [], channels: [{ id: id('channel'), name: 'geral', category: 'Geral', messages: [] }] };
    state.groups.unshift(group); selectedGroupId = group.id; selectedChannelId = group.channels[0].id; dialog.close(); save(); toast('Grupo criado nesta demonstração.'); return;
  }
  if (type === 'accept-invite') {
    const code = String(values.get('code') || '').trim().toUpperCase();
    if (firebaseMode) {
      try {
        const result = await FirebaseRepository.redeemInvite(code);
        const claims = await FirebaseAuthAdapter.claims(firebaseUser);
        state = await FirebaseRepository.load(firebaseUser, claims);
        selectedGroupId = result.groupId; selectedChannelId = state.groups.find(group => group.id === result.groupId)?.channels[0]?.id || '';
        dialog.close(); setRoute('groups', { groupId: selectedGroupId, channelId: selectedChannelId }); render(); toast('Convite aceito. Você entrou no grupo.');
      } catch (error) { toast(error.message); }
      return;
    }
    const invite = pendingInviteCodes.get(code);
    if (!invite || invite.expiresAt < Date.now()) { toast('Código inválido ou expirado.'); return; }
    const group = state.groups.find(item => item.id === invite.groupId);
    if (!group || group.visibility !== 'private') { toast('O grupo não está disponível.'); return; }
    if (!group.members.some(member => member.userId === currentUser().id)) group.members.push({ userId: currentUser().id, role: 'member', joinedAt: Date.now() });
    pendingInviteCodes.delete(code); selectedGroupId = group.id; selectedChannelId = group.channels[0]?.id || ''; dialog.close(); save(); toast('Convite aceito. Você entrou no grupo.'); return;
  }
  if (type === 'add-channel') {
    const group = currentGroup();
    if (!group || !canManageGroup(group, currentUser().id)) return toast('Você não pode criar canais neste grupo.');
    group.channels.push({ id: id('channel'), name: String(values.get('name')).trim().replace(/^#/, ''), category: String(values.get('category') || 'Geral').trim(), messages: [] });
    selectedChannelId = group.channels.at(-1).id; dialog.close(); addAudit(`Canal adicionado ao grupo ${group.name}`); save(); return;
  }
  if (type === 'add-event') {
    state.events.push({ id: id('event'), title: String(values.get('title')).trim(), date: String(values.get('date')), type: String(values.get('type')), description: String(values.get('description') || '').trim() });
    dialog.close(); save(); toast('Data adicionada à agenda local.'); return;
  }
  if (type === 'edit-profile') {
    const name = String(values.get('name') || '').trim();
    if (!/^[\p{L}]+(?:[ '\-][\p{L}]+){1,5}$/u.test(name)) return toast('Informe um nome plausível, sem números.');
    const user = currentUser();
    const normalizeName = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
    if (state.users.some(candidate => candidate.id !== user.id && normalizeName(candidate.name) === normalizeName(name))) return toast('Este nome já está em uso nesta demonstração.');
    const avatarFile = values.get('avatar');
    const bannerFile = values.get('banner');
    try {
      user.avatar = avatarFile?.size ? (firebaseMode ? await FirebaseRepository.uploadImage(avatarFile, 'avatar', user.id) : await StorageAdapter.image(avatarFile)) : user.avatar;
      user.banner = bannerFile?.size ? (firebaseMode ? await FirebaseRepository.uploadImage(bannerFile, 'banner', user.id) : await StorageAdapter.image(bannerFile)) : user.banner;
    } catch (error) { return toast(error.message); }
    user.name = name; user.bio = String(values.get('bio') || '').trim(); user.classId = String(values.get('classId') || '');
    dialog.close(); save(); toast('Perfil atualizado localmente.'); return;
  }
  if (type === 'add-notice') {
    if (!isStaff()) return toast('Ação reservada à equipe.');
    state.notices.unshift({ id: id('notice'), title: String(values.get('title')).trim(), text: String(values.get('text')).trim(), createdAt: Date.now() });
    dialog.close(); addAudit('Aviso oficial publicado'); save(); return;
  }
}

document.addEventListener('click', event => {
  const pageButton = event.target.closest('[data-page]');
  if (pageButton) {
    event.preventDefault();
    setRoute(pageButton.dataset.page);
    searchTerm = '';
    dialog.close();
    if (page === 'admin' && !isStaff()) { toast('Área da equipe indisponível para este papel.'); setRoute('feed'); }
    render(); document.querySelector('#main')?.focus({ preventScroll: true }); window.scrollTo(0, 0); return;
  }
  const button = event.target.closest('[data-action], [data-auth-mode]');
  if (button) handleDialogAction(button);
});

document.addEventListener('submit', event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  submitForm(form);
});

document.addEventListener('input', event => {
  if (!event.target.matches('[data-search-input]')) return;
  searchTerm = event.target.value;
  const position = event.target.selectionStart;
  render();
  const fresh = document.querySelector('[data-search-input]');
  fresh?.focus(); fresh?.setSelectionRange(position, position);
});

document.addEventListener('change', event => {
  const pref = event.target.dataset.pref;
  const privacy = event.target.dataset.prefPrivacy;
  if (pref) {
    state.settings[pref] = event.target.type === 'checkbox' ? event.target.checked : event.target.type === 'range' ? Number(event.target.value) : event.target.value;
    save(); return;
  }
  if (privacy) { currentUser().privacy ||= {}; currentUser().privacy[privacy] = event.target.checked; save(); return; }
  if (event.target.matches('[data-demo-role]')) {
    currentUser().role = event.target.value;
    save(); toast('Papel alterado apenas na prévia local.'); return;
  }
  if (event.target.matches('[data-demo-user]')) {
    state.currentUserId = event.target.value;
    selectedGroupId = '';
    selectedChannelId = '';
    viewUserId = '';
    if (page === 'admin' && !isStaff()) setRoute('feed');
    else setRoute(page);
    save();
    toast('Pessoa da demonstração alterada. Nenhuma autenticação ocorreu.');
    return;
  }
  if (event.target.matches('[data-member-role]')) {
    const [groupId, userId] = event.target.dataset.memberRole.split('|');
    const group = state.groups.find(item => item.id === groupId);
    if (!group || !canManageGroup(group, currentUser().id) || group.ownerId === userId) return toast('Você não pode alterar esse papel.');
    const member = group.members.find(item => item.userId === userId);
    if (member) { member.role = event.target.value; addAudit(`Papel de membro alterado no grupo ${group.name}`); save(); }
  }
});

dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener('cancel', () => { /* Native Escape handling preserves dialog semantics. */ });

window.addEventListener('popstate', restoreRoute);
window.addEventListener('hashchange', restoreRoute);
if (firebaseMode) {
  render();
  FirebaseAuthAdapter.observe(onFirebaseUser, error => { firebaseStatus = 'error'; firebaseError = error.message || 'Falha ao iniciar Firebase Auth.'; render(); })
    .then(unsubscribe => { firebaseUnsubscribe = unsubscribe; })
    .catch(error => { firebaseStatus = 'error'; firebaseError = error.message || 'Falha ao carregar o SDK Firebase.'; render(); });
} else restoreRoute();

