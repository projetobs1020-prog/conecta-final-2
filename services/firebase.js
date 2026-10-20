import { firebaseConfig, useFirebaseEmulators } from './firebase-config.js';
import { emptyState } from '../data.js';

const sdkVersion = '12.19.0';
const firebaseUrl = part => `https://www.gstatic.com/firebasejs/${sdkVersion}/firebase-${part}.js`;
let servicesPromise;
let previousCloudState;

export const firebaseConfigured = () => Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);

async function services() {
  if (!firebaseConfigured()) throw new Error('Firebase ainda não foi configurado. Preencha services/firebase-config.js.');
  if (!servicesPromise) servicesPromise = (async () => {
    const [appSdk, authSdk, dbSdk, storageSdk, functionsSdk] = await Promise.all([
      import(firebaseUrl('app')),
      import(firebaseUrl('auth')),
      import(firebaseUrl('firestore')),
      import(firebaseUrl('storage')),
      import(firebaseUrl('functions')),
    ]);
    const app = appSdk.initializeApp(firebaseConfig);
    const auth = authSdk.getAuth(app);
    const db = dbSdk.getFirestore(app);
    const storage = storageSdk.getStorage(app);
    const functions = functionsSdk.getFunctions(app);
    if (useFirebaseEmulators) {
      authSdk.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      dbSdk.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      storageSdk.connectStorageEmulator(storage, '127.0.0.1', 9199);
      functionsSdk.connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    }
    return { app, auth, db, storage, functions, authSdk, dbSdk, storageSdk, functionsSdk };
  })();
  return servicesPromise;
}

const errorMessage = error => ({
  'auth/email-already-in-use': 'Este e-mail já possui uma conta.',
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'Confira o formato do e-mail.',
  'auth/weak-password': 'Use uma senha mais longa e segura.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente novamente.',
  'auth/network-request-failed': 'Não foi possível conectar ao Firebase. Confira sua conexão.',
  'permission-denied': 'O Firebase bloqueou esta ação pelas regras de segurança.',
}[error?.code] || error?.message || 'Não foi possível concluir a ação no Firebase.');

export const FirebaseAuthAdapter = {
  async observe(callback, onError = () => {}) {
    const { auth, authSdk } = await services();
    return authSdk.onAuthStateChanged(auth, callback, onError);
  },
  async request({ mode, email = '', password = '', name = '' }) {
    const { auth, authSdk, functions, functionsSdk } = await services();
    try {
      if (mode === 'signup') {
        const credential = await authSdk.createUserWithEmailAndPassword(auth, email, password);
        await authSdk.updateProfile(credential.user, { displayName: name });
        await authSdk.sendEmailVerification(credential.user);
        return { ok: true, message: 'Conta criada. Abra o link de confirmação enviado ao seu e-mail escolar.' };
      }
      if (mode === 'login') {
        const credential = await authSdk.signInWithEmailAndPassword(auth, email, password);
        await authSdk.reload(credential.user);
        if (!credential.user.emailVerified) return { ok: true, needsVerification: true, message: 'Confirme seu e-mail pelo link enviado antes de entrar.' };
        return { ok: true, message: 'Acesso confirmado.' };
      }
      if (mode === 'recovery') {
        await authSdk.sendPasswordResetEmail(auth, email);
        return { ok: true, message: 'Se o endereço estiver cadastrado, o Firebase enviará instruções de recuperação.' };
      }
      if (mode === 'email') {
        if (!auth.currentUser) throw new Error('Entre na conta para reenviar a confirmação por e-mail.');
        await authSdk.sendEmailVerification(auth.currentUser);
        return { ok: true, message: 'Novo link de confirmação enviado.' };
      }
      if (mode === 'twofactor') throw new Error('2FA por telefone ainda requer escolher o provedor, números autorizados e configurar reCAPTCHA no Firebase Console.');
      if (mode === 'signout') { await authSdk.signOut(auth); return { ok: true }; }
      if (mode === 'reload') { if (auth.currentUser) await authSdk.reload(auth.currentUser); return { ok: true }; }
      if (mode === 'ensure-profile') {
        const call = functionsSdk.httpsCallable(functions, 'ensureProfile');
        return (await call({ name: auth.currentUser?.displayName || name })).data;
      }
      throw new Error('Fluxo de conta desconhecido.');
    } catch (error) {
      throw new Error(errorMessage(error));
    }
  },
  async claims(user) {
    const token = await user.getIdTokenResult();
    return token.claims;
  },
  async call(name, payload) {
    const { functions, functionsSdk } = await services();
    try { return (await functionsSdk.httpsCallable(functions, name)(payload)).data; }
    catch (error) { throw new Error(errorMessage(error)); }
  },
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function docData(snapshot) { return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null; }
function profileShape(doc, uid, claims = {}) {
  return {
    id: uid, name: doc?.name || 'Estudante', handle: doc?.handle || uid.slice(0, 10),
    role: ['professor', 'secretaria', 'administrador'].includes(claims.role) ? claims.role : (doc?.role || 'aluno'),
    classId: doc?.classId || '', school: doc?.school || '', bio: doc?.bio || '', avatar: doc?.avatar || '', banner: doc?.banner || '',
    verified: Boolean(claims.schoolVerified ?? doc?.verified), privacy: doc?.privacy || { profileVisible: true, showClass: false, showSchool: false, discoverable: true },
  };
}
function profileWrite(user) {
  const privacy = user.privacy || {};
  return {
    classId: user.classId || '', bio: user.bio || '', avatar: user.avatar || '', banner: user.banner || '',
    privacy, profileVisible: privacy.profileVisible !== false, discoverable: privacy.discoverable !== false,
    publicClassId: privacy.showClass === false ? '' : (user.classId || ''), publicSchool: privacy.showSchool === false ? '' : (user.school || ''),
    updatedAt: Date.now(),
  };
}
function groupWrite(group) {
  const members = group.members || [];
  return {
    id: group.id, name: group.name, description: group.description, visibility: group.visibility, category: group.category,
    ownerId: group.ownerId, rules: group.rules, members, memberUids: members.map(member => member.userId),
    moderatorUids: members.filter(member => member.role === 'moderator').map(member => member.userId),
    channels: (group.channels || []).map(({ id, name, category }) => ({ id, name, category })),
  };
}
function messageMap(state) {
  return (state.groups || []).flatMap(group => (group.channels || []).flatMap(channel => (channel.messages || []).map(message => ({ ...message, groupId: group.id, channelId: channel.id }))));
}

export const FirebaseRepository = {
  async load(user, claims = {}) {
    const { db, dbSdk, functions, functionsSdk } = await services();
    const staff = ['professor', 'secretaria', 'administrador'].includes(claims.role);
    await functionsSdk.httpsCallable(functions, 'ensureProfile')({ name: user.displayName || '' });
    const ownProfileRef = dbSdk.doc(db, 'users', user.uid);
    const ownProfileSnapshot = await dbSdk.getDoc(ownProfileRef);
    const ownProfile = docData(ownProfileSnapshot) || {};
    const [profilesSnap, postsSnap, staffPostsSnap, publicGroupsSnap, memberGroupsSnap, privateCatalogSnap, noticesSnap, eventsSnap, preferenceSnap] = await Promise.all([
      dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'publicProfiles'), dbSdk.where('profileVisible', '==', true), dbSdk.limit(100))),
      dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'posts'), dbSdk.where('moderation.status', 'in', ['clear', 'review']), dbSdk.orderBy('createdAt', 'desc'), dbSdk.limit(100))),
      staff ? dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'posts'), dbSdk.where('moderation.status', '==', 'review'), dbSdk.orderBy('createdAt', 'desc'), dbSdk.limit(100))) : Promise.resolve({ docs: [] }),
      dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'groups'), dbSdk.where('visibility', '==', 'public'), dbSdk.limit(100))),
      dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'groups'), dbSdk.where('visibility', '==', 'private'), dbSdk.where('memberUids', 'array-contains', user.uid), dbSdk.limit(100))),
      dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'groupCatalog'), dbSdk.where('visibility', '==', 'private'), dbSdk.limit(100))),
      dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'notices'), dbSdk.orderBy('createdAt', 'desc'), dbSdk.limit(50))),
      dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'events'), dbSdk.orderBy('date'), dbSdk.limit(100))),
      dbSdk.getDoc(dbSdk.doc(db, 'users', user.uid, 'private', 'preferences')),
    ]);
    const users = new Map();
    for (const snapshot of profilesSnap.docs) users.set(snapshot.id, profileShape({ id: snapshot.id, ...snapshot.data() }, snapshot.id));
    users.set(user.uid, profileShape(ownProfile, user.uid, claims));
    const postDocs = new Map([...postsSnap.docs, ...staffPostsSnap.docs].map(snapshot => [snapshot.id, snapshot]));
    const posts = await Promise.all([...postDocs.values()].map(async snapshot => {
      const post = docData(snapshot);
      const [likes, comments] = await Promise.all([
        dbSdk.getDocs(dbSdk.collection(db, 'posts', post.id, 'likes')),
        dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'posts', post.id, 'comments'), dbSdk.where('moderation.status', 'in', ['clear', 'review']), dbSdk.orderBy('createdAt'), dbSdk.limit(200))),
      ]);
      return { ...post, likes: likes.docs.map(item => item.id), comments: comments.docs.map(item => ({ id: item.id, ...item.data() })) };
    }));
    const groupDocs = new Map([...publicGroupsSnap.docs, ...memberGroupsSnap.docs].map(snapshot => [snapshot.id, snapshot]));
    const groups = await Promise.all([...groupDocs.values()].map(async snapshot => {
      const group = docData(snapshot);
      const [messages, requests] = await Promise.all([
        dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'groups', group.id, 'messages'), dbSdk.where('moderation.status', 'in', ['clear', 'review']), dbSdk.orderBy('createdAt'), dbSdk.limit(300))),
        ['owner', 'moderator'].includes(group.members?.find(member => member.userId === user.uid)?.role)
          ? dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'groups', group.id, 'joinRequests'), dbSdk.where('status', '==', 'Pendente')))
          : Promise.resolve({ docs: [] }),
      ]);
      const channels = (group.channels || []).map(channel => ({ ...channel, messages: messages.docs.filter(item => item.data().channelId === channel.id).map(item => ({ id: item.id, ...item.data() })) }));
      return { ...group, channels, joinRequests: requests.docs.map(item => ({ id: item.id, ...item.data() })) };
    }));
    for (const catalogDoc of privateCatalogSnap.docs) if (!groupDocs.has(catalogDoc.id)) {
      const catalog = catalogDoc.data();
      const ownRequest = await dbSdk.getDoc(dbSdk.doc(db, 'groups', catalogDoc.id, 'joinRequests', user.uid));
      groups.push({ id: catalogDoc.id, name: catalog.name || 'Grupo privado', description: catalog.description || '', visibility: 'private', category: catalog.category || 'Grupos', ownerId: catalog.ownerId || '', rules: '', members: [], memberCount: catalog.memberCount || 0, channels: [], joinRequests: ownRequest.exists() ? [{ id: ownRequest.id, ...ownRequest.data() }] : [] });
    }
    const prefs = preferenceSnap.exists() ? preferenceSnap.data() : {};
    let reports = [];
    try {
      const reportsSnap = await dbSdk.getDocs(staff
        ? dbSdk.query(dbSdk.collection(db, 'reports'), dbSdk.orderBy('createdAt', 'desc'), dbSdk.limit(100))
        : dbSdk.query(dbSdk.collection(db, 'reports'), dbSdk.where('authorId', '==', user.uid), dbSdk.orderBy('createdAt', 'desc'), dbSdk.limit(50)));
      reports = reportsSnap.docs.map(docData);
    } catch { /* A new project can be missing the optional report index until deployed. */ }
    let audit = [];
    if (staff) {
      const auditSnap = await dbSdk.getDocs(dbSdk.query(dbSdk.collection(db, 'adminAudit'), dbSdk.orderBy('createdAt', 'desc'), dbSdk.limit(100)));
      audit = auditSnap.docs.map(docData);
    }
    const state = emptyState(profileShape(ownProfile, user.uid, claims));
    state.users = [...users.values()]; state.posts = posts; state.groups = groups;
    state.notices = noticesSnap.docs.map(docData); state.events = eventsSnap.docs.map(docData);
    state.reports = reports; state.audit = audit; state.currentUserId = user.uid;
    state.settings = { ...state.settings, ...(prefs.settings || {}) };
    state.blockedUserIdsByUser[user.uid] = prefs.blockedUserIds || [];
    state.hiddenPostIdsByUser[user.uid] = prefs.hiddenPostIds || [];
    state.hiddenPostIds = prefs.hiddenPostIdsGlobal || []; state.hiddenMessageIds = prefs.hiddenMessageIds || [];
    previousCloudState = clone(state);
    return state;
  },

  async save(state) {
    if (!previousCloudState) throw new Error('A sessão Firebase ainda não carregou os dados.');
    const { db, dbSdk, storage, storageSdk } = await services();
    const before = previousCloudState;
    const uid = state.currentUserId;
    const writes = [];
    const syncCollection = (name, previous, next, serialize, canWrite = () => true) => {
      const oldMap = new Map((previous || []).map(item => [item.id, item]));
      const newMap = new Map((next || []).map(item => [item.id, item]));
      for (const [id, item] of newMap) {
        const old = oldMap.get(id);
        if ((!old || !same(old, item)) && canWrite(item)) writes.push(dbSdk.setDoc(dbSdk.doc(db, name, id), serialize(item)));
      }
      for (const [id, item] of oldMap) if (!newMap.has(id) && canWrite(item)) writes.push(dbSdk.deleteDoc(dbSdk.doc(db, name, id)));
    };

    const currentProfile = (state.users || []).find(item => item.id === uid);
    const previousProfile = (before.users || []).find(item => item.id === uid);
    if (currentProfile && !same(previousProfile, currentProfile)) {
      if (previousProfile && previousProfile.name !== currentProfile.name) writes.push(FirebaseAuthAdapter.call('updateProfileName', { name: currentProfile.name }));
      const profile = profileWrite(currentProfile);
      const { publicClassId, publicSchool, classId, profileVisible, discoverable, ...privateFields } = profile;
      writes.push(dbSdk.setDoc(dbSdk.doc(db, 'users', uid), { ...privateFields, classId }, { merge: true }));
      writes.push(dbSdk.setDoc(dbSdk.doc(db, 'publicProfiles', uid), {
        bio: profile.bio, avatar: profile.avatar, banner: profile.banner,
        profileVisible: profile.profileVisible, discoverable: profile.discoverable, classId: publicClassId, school: publicSchool,
        privacy: profile.privacy, updatedAt: profile.updatedAt,
      }, { merge: true }));
    }

    const serializePost = post => {
      const { comments, likes, ...safe } = post;
      return { ...safe, authorId: uid === post.authorId ? uid : post.authorId, createdAt: Number(post.createdAt), updatedAt: Number(post.updatedAt), moderation: post.moderation || { status: 'clear', signals: [] } };
    };
    const oldPosts = new Map((before.posts || []).map(post => [post.id, post]));
    const newPosts = new Map((state.posts || []).map(post => [post.id, post]));
    for (const [id, post] of newPosts) {
      const old = oldPosts.get(id);
      const contentChanged = !old || !same({ ...old, comments: [], likes: [] }, { ...post, comments: [], likes: [] });
      if (!old && post.authorId === uid) writes.push(FirebaseAuthAdapter.call('publishPost', { post: serializePost(post) }));
      else if (old && contentChanged && post.authorId === uid) writes.push(FirebaseAuthAdapter.call('updatePost', { postId: id, text: post.text }));
      else if (old && contentChanged && isStaff(state) && old.moderation?.status !== post.moderation?.status) writes.push(FirebaseAuthAdapter.call('reviewPostContent', { postId: id, status: post.moderation.status }));
      const oldLikes = new Set(old?.likes || []), nextLikes = new Set(post.likes || []);
      if (oldLikes.has(uid) !== nextLikes.has(uid)) {
        const ref = dbSdk.doc(db, 'posts', id, 'likes', uid);
        writes.push(nextLikes.has(uid) ? dbSdk.setDoc(ref, { userId: uid, createdAt: Date.now() }) : dbSdk.deleteDoc(ref));
      }
      const oldComments = new Map((old?.comments || []).map(comment => [comment.id, comment]));
      const nextComments = new Map((post.comments || []).map(comment => [comment.id, comment]));
      for (const [commentId, comment] of nextComments) if (!oldComments.has(commentId) && comment.authorId === uid) writes.push(FirebaseAuthAdapter.call('addPostComment', { postId: id, comment }));
      for (const [commentId, comment] of oldComments) if (!nextComments.has(commentId) && comment.authorId === uid) writes.push(dbSdk.deleteDoc(dbSdk.doc(db, 'posts', id, 'comments', commentId)));
    }
    for (const [id, post] of oldPosts) if (!newPosts.has(id)) writes.push(FirebaseAuthAdapter.call('deletePost', { postId: id }));

    const oldGroups = new Map((before.groups || []).map(group => [group.id, group]));
    const nextGroups = new Map((state.groups || []).map(group => [group.id, group]));
    for (const [id, group] of nextGroups) {
      const old = oldGroups.get(id);
      if ((!old || !same(groupWrite(old), groupWrite(group))) && (!old ? group.ownerId === uid : group.ownerId === uid || group.members?.some(member => member.userId === uid && member.role === 'moderator'))) {
        writes.push(dbSdk.setDoc(dbSdk.doc(db, 'groups', id), groupWrite(group)));
      } else if (old && group.visibility === 'public' && !old.members.some(member => member.userId === uid) && group.members.some(member => member.userId === uid)) {
        writes.push(dbSdk.updateDoc(dbSdk.doc(db, 'groups', id), { members: groupWrite(group).members, memberUids: groupWrite(group).memberUids, moderatorUids: groupWrite(group).moderatorUids }));
      } else if (old && old.members.some(member => member.userId === uid) && !group.members.some(member => member.userId === uid)) {
        writes.push(dbSdk.updateDoc(dbSdk.doc(db, 'groups', id), { members: groupWrite(group).members, memberUids: groupWrite(group).memberUids, moderatorUids: groupWrite(group).moderatorUids }));
      }
      const oldRequests = new Map((old?.joinRequests || []).map(item => [item.userId, item]));
      const nextRequests = new Map((group.joinRequests || []).map(item => [item.userId, item]));
      for (const [userId, request] of nextRequests) if (!oldRequests.has(userId)) writes.push(dbSdk.setDoc(dbSdk.doc(db, 'groups', id, 'joinRequests', userId), { ...request, userId, groupId: id }));
      for (const [userId, request] of oldRequests) if (!nextRequests.has(userId)) writes.push(dbSdk.deleteDoc(dbSdk.doc(db, 'groups', id, 'joinRequests', userId)));
    }
    for (const [id] of oldGroups) if (!nextGroups.has(id)) writes.push(FirebaseAuthAdapter.call('deleteGroup', { groupId: id }));

    const oldMessages = new Map(messageMap(before).map(message => [message.id, message]));
    const nextMessages = new Map(messageMap(state).map(message => [message.id, message]));
    for (const [id, message] of nextMessages) {
      const old = oldMessages.get(id); const ref = dbSdk.doc(db, 'groups', message.groupId, 'messages', id);
      if (!old && message.authorId === uid) writes.push(FirebaseAuthAdapter.call('sendGroupMessage', { groupId: message.groupId, channelId: message.channelId, message }));
      else if (old && !same(old.moderation, message.moderation)) writes.push(dbSdk.updateDoc(ref, { moderation: message.moderation }));
      else if (old && !same(old.readBy, message.readBy)) writes.push(dbSdk.updateDoc(ref, { readBy: message.readBy || [] }));
    }
    for (const [id, message] of oldMessages) if (!nextMessages.has(id) && message.authorId === uid) writes.push(dbSdk.deleteDoc(dbSdk.doc(db, 'groups', message.groupId, 'messages', id)));

    const normalizeTop = item => ({ ...item, createdAt: Number(item.createdAt || Date.now()) });
    syncCollection('notices', before.notices, state.notices, normalizeTop, () => isStaff(state));
    syncCollection('events', before.events, state.events, normalizeTop, () => isStaff(state));
    const oldReports = new Map((before.reports || []).map(report => [report.id, report]));
    for (const report of state.reports || []) {
      const old = oldReports.get(report.id);
      if (!old && report.authorId === uid) writes.push(FirebaseAuthAdapter.call('submitReport', { report: normalizeTop(report) }));
      else if (old && old.status !== report.status && isStaff(state)) writes.push(FirebaseAuthAdapter.call('reviewReport', { reportId: report.id, status: report.status }));
    }
    if (isStaff(state)) syncCollection('adminAudit', before.audit, state.audit, normalizeTop);
    const prefs = {
      settings: state.settings,
      blockedUserIds: state.blockedUserIdsByUser?.[uid] || [],
      hiddenPostIds: state.hiddenPostIdsByUser?.[uid] || [],
      hiddenPostIdsGlobal: isStaff(state) ? state.hiddenPostIds || [] : [],
      hiddenMessageIds: isStaff(state) ? state.hiddenMessageIds || [] : [],
      updatedAt: Date.now(),
    };
    if (!same(before.settings, state.settings) || !same(before.blockedUserIdsByUser?.[uid], state.blockedUserIdsByUser?.[uid]) || !same(before.hiddenPostIdsByUser?.[uid], state.hiddenPostIdsByUser?.[uid])) {
      writes.push(dbSdk.setDoc(dbSdk.doc(db, 'users', uid, 'private', 'preferences'), prefs));
    }
    await Promise.all(writes);
    previousCloudState = clone(state);
  },

  async uploadImage(file, kind, uid) {
    const { storage, storageSdk } = await services();
    if (!file || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Escolha uma imagem PNG, JPEG, WebP ou GIF.');
    if (file.size > 1200000) throw new Error('Use uma imagem de até 1,2 MB.');
    const name = `${Date.now()}-${crypto.randomUUID()}.${file.type.split('/')[1].replace('jpeg', 'jpg')}`;
    const path = kind === 'post' ? `post-media/${uid}/${name}` : `profile-media/${uid}/${kind}/${name}`;
    const result = await storageSdk.uploadBytes(storageSdk.ref(storage, path), file, { contentType: file.type });
    return storageSdk.getDownloadURL(result.ref);
  },

  async createInvite(groupId) { return FirebaseAuthAdapter.call('createGroupInvite', { groupId }); },
  async redeemInvite(code) { return FirebaseAuthAdapter.call('redeemGroupInvite', { code }); },
};

function isStaff(state) { return ['professor', 'secretaria', 'administrador'].includes(state.users?.find(user => user.id === state.currentUserId)?.role); }
