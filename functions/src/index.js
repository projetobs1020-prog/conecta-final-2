import { createHash, randomBytes } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';

initializeApp();
const db = getFirestore();
const nameKey = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const requireUser = request => {
  if (!request.auth?.uid || !request.auth.token.email_verified) throw new HttpsError('unauthenticated', 'Entre e confirme seu e-mail antes de continuar.');
  return request.auth.uid;
};
const hasRole = (request, roles) => roles.includes(request.auth?.token.role);
const requireStaff = request => {
  requireUser(request);
  if (!hasRole(request, ['professor', 'secretaria', 'administrador'])) throw new HttpsError('permission-denied', 'Ação restrita à equipe escolar.');
};
const requireManager = (group, uid) => {
  if (!group || (group.ownerId !== uid && !(group.moderatorUids || []).includes(uid))) throw new HttpsError('permission-denied', 'Você não administra este grupo.');
};
const moderationRules = [
  ['threat', 'Possível ameaça', /\b(vou te matar|vou matar voce|ameaca de morte|morte para voce|vou te encontrar e)\b/, 'high'],
  ['severe-insult', 'Possível insulto grave', /\b(vai tomar no cu|filho da puta|desgracado|retardado)\b/, 'normal'],
  ['violence', 'Possível incentivo à violência', /\b(vamos atacar|ataquem (a|os|as)|mate(m)? todos|vamos explodir)\b/, 'high'],
  ['hate', 'Possível ataque discriminatório', /\b(inferior por (sua )?raca|morte a (todos os )?(imigrantes|[a-z]+ por sua raca)|expulsar todos os [a-z]+ por)\b/, 'high'],
  ['extremism', 'Possível propaganda extremista', /\b(heil hitler|supremacia ariana|exterminio de (um )?povo|nazismo e a solucao|junte se a (um )?grupo neonazista)\b/, 'high'],
  ['minor-safety', 'Possível risco grave à segurança de menores', /\b(enviar fotos intimas de (uma )?crianca|encontro sexual com (uma )?crianca|explorar sexualmente (uma )?crianca)\b/, 'urgent'],
  ['harassment', 'Possível assédio ou perseguição', /\b(vou te perseguir|nao vou parar de te seguir|vou divulgar seu endereco)\b/, 'high'],
  ['spam', 'Possível spam ou tentativa de burlar filtros', /\b(clique aqui para ganhar|envie sua senha|http\s+http\s+http)\b/, 'normal'],
];
const moderate = value => {
  const text = String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[аеорсхуіј]/g, char => ({ а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j' })[char] || char)
    .replace(/[0@]/g, 'o').replace(/[1!|]/g, 'i').replace(/\$/g, 's').replace(/(.)\1{1,}/g, '$1').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const matches = moderationRules.filter(([, , pattern]) => pattern.test(text)).map(([code, label, , priority]) => ({ code, label, priority }));
  const educationalContext = /\b(aula|historia|historico|jornalismo|reportagem|pesquisa|estudo|educativo|documentario|contexto historico)\b/.test(text);
  return { status: matches.length ? 'review' : 'clear', signals: matches, educationalContext, blockPreview: matches.some(item => item.priority === 'urgent') && !educationalContext };
};
const contentId = value => /^[A-Za-z0-9_-]{3,100}$/.test(String(value || ''));

export const publishPost = onCall(async request => {
  const uid = requireUser(request);
  const post = request.data?.post || {};
  if (!contentId(post.id) || typeof post.text !== 'string' || !post.text.trim() || post.text.length > 1500) throw new HttpsError('invalid-argument', 'Publicação inválida.');
  const moderation = moderate(post.text);
  if (moderation.blockPreview) {
    await db.collection('safetySignals').add({ actorId: uid, contentHash: sha256(post.text), targetType: 'post', createdAt: Date.now(), status: 'pending' });
    throw new HttpsError('failed-precondition', 'O envio foi interrompido e encaminhado para revisão de segurança.');
  }
  if (post.image && !/^https:\/\/firebasestorage\.googleapis\.com\//.test(post.image)) throw new HttpsError('invalid-argument', 'A imagem precisa estar no Firebase Storage.');
  const ref = db.doc(`posts/${post.id}`);
  if ((await ref.get()).exists) throw new HttpsError('already-exists', 'Identificador de publicação duplicado.');
  await ref.create({ id: post.id, authorId: uid, text: post.text.trim(), image: post.image || '', imageAlt: String(post.imageAlt || '').slice(0, 180), createdAt: Number(post.createdAt) || Date.now(), updatedAt: Date.now(), moderation });
  return { ok: true, moderation };
});

export const updatePost = onCall(async request => {
  const uid = requireUser(request);
  const postId = String(request.data?.postId || '');
  const text = String(request.data?.text || '').trim();
  if (!contentId(postId) || !text || text.length > 1500) throw new HttpsError('invalid-argument', 'Alteração inválida.');
  const moderation = moderate(text);
  if (moderation.blockPreview) throw new HttpsError('failed-precondition', 'A alteração foi interrompida para revisão de segurança.');
  const ref = db.doc(`posts/${postId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.data().authorId !== uid) throw new HttpsError('permission-denied', 'Você não pode editar esta publicação.');
  await ref.update({ text, updatedAt: Date.now(), moderation });
  return { ok: true };
});

export const addPostComment = onCall(async request => {
  const uid = requireUser(request);
  const postId = String(request.data?.postId || ''), comment = request.data?.comment || {};
  const text = String(comment.text || '').trim();
  if (!contentId(postId) || !contentId(comment.id) || !text || text.length > 400) throw new HttpsError('invalid-argument', 'Comentário inválido.');
  const postRef = db.doc(`posts/${postId}`), post = await postRef.get();
  if (!post.exists || post.data().moderation?.status === 'hidden') throw new HttpsError('not-found', 'Publicação não disponível.');
  const moderation = moderate(text);
  if (moderation.blockPreview) throw new HttpsError('failed-precondition', 'O comentário foi interrompido para revisão de segurança.');
  await db.doc(`posts/${postId}/comments/${comment.id}`).create({ id: comment.id, authorId: uid, text, createdAt: Number(comment.createdAt) || Date.now(), moderation });
  return { ok: true, moderation };
});

export const sendGroupMessage = onCall(async request => {
  const uid = requireUser(request);
  const groupId = String(request.data?.groupId || ''), channelId = String(request.data?.channelId || ''), message = request.data?.message || {};
  if (!contentId(groupId) || !contentId(channelId) || !contentId(message.id) || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 1000) throw new HttpsError('invalid-argument', 'Mensagem inválida.');
  const groupRef = db.doc(`groups/${groupId}`);
  const groupSnapshot = await groupRef.get();
  const group = groupSnapshot.data();
  if (!group || !(group.memberUids || []).includes(uid) || !(group.channels || []).some(channel => channel.id === channelId)) throw new HttpsError('permission-denied', 'Entre no grupo antes de enviar mensagens.');
  const moderation = moderate(message.text);
  if (moderation.blockPreview) {
    await db.collection('safetySignals').add({ actorId: uid, groupId, contentHash: sha256(message.text), targetType: 'message', createdAt: Date.now(), status: 'pending' });
    throw new HttpsError('failed-precondition', 'O envio foi interrompido e encaminhado para revisão de segurança.');
  }
  await db.doc(`groups/${groupId}/messages/${message.id}`).create({ id: message.id, groupId, channelId, authorId: uid, text: message.text.trim(), createdAt: Number(message.createdAt) || Date.now(), readBy: [uid], moderation });
  return { ok: true, moderation };
});

export const reviewPostContent = onCall(async request => {
  requireStaff(request);
  const postId = String(request.data?.postId || ''), status = String(request.data?.status || '');
  if (!contentId(postId) || !['clear', 'review', 'hidden', 'reviewed'].includes(status)) throw new HttpsError('invalid-argument', 'Revisão inválida.');
  await db.doc(`posts/${postId}`).update({ 'moderation.status': status, reviewedBy: request.auth.uid, reviewedAt: Date.now() });
  await db.collection('adminAudit').add({ actorId: request.auth.uid, action: 'post-moderation-updated', targetId: postId, status, createdAt: Date.now() });
  return { ok: true };
});

export const submitReport = onCall(async request => {
  const uid = requireUser(request);
  const report = request.data?.report || {};
  const targetType = String(report.targetType || ''), targetId = String(report.targetId || ''), reason = String(report.reason || 'Outro');
  const details = String(report.details || '').slice(0, 600);
  if (!contentId(report.id) || !targetId || !['publicação', 'mensagem', 'grupo'].includes(targetType)) throw new HttpsError('invalid-argument', 'Denúncia inválida.');
  const safety = reason.includes('criança') || reason.includes('adolescente');
  if (safety && targetType === 'publicação') await db.doc(`posts/${targetId}`).update({ 'moderation.status': 'hidden', 'moderation.signals': [{ code: 'minor-safety-report', label: 'Conteúdo oculto após denúncia de risco envolvendo menor', priority: 'urgent' }] });
  if (safety && targetType === 'mensagem') {
    const [groupId, messageId] = targetId.split('|');
    if (contentId(groupId) && contentId(messageId)) await db.doc(`groups/${groupId}/messages/${messageId}`).update({ 'moderation.status': 'hidden', 'moderation.signals': [{ code: 'minor-safety-report', label: 'Conteúdo oculto após denúncia de risco envolvendo menor', priority: 'urgent' }] });
  }
  const ref = db.doc(`reports/${report.id}`);
  await ref.create({ id: report.id, authorId: uid, targetType, targetId, reason, details, severity: safety, status: 'Pendente', createdAt: Number(report.createdAt) || Date.now() });
  return { ok: true, hidden: safety };
});

export const ensureProfile = onCall(async request => {
  const uid = requireUser(request);
  const authUser = await getAuth().getUser(uid);
  const displayName = String(request.data?.name || authUser.displayName || '').trim();
  if (!/^[\p{L}]+(?:[ '\-][\p{L}]+){1,5}$/u.test(displayName)) throw new HttpsError('invalid-argument', 'Informe um nome completo plausível, sem números.');
  const normalized = nameKey(displayName);
  if (normalized.length < 5) throw new HttpsError('invalid-argument', 'Confira o nome informado.');
  const userRef = db.doc(`users/${uid}`);
  const publicRef = db.doc(`publicProfiles/${uid}`);
  const registryRef = db.doc(`nameRegistry/${normalized}`);
  try {
    await db.runTransaction(async transaction => {
      const [userSnapshot, registrySnapshot] = await Promise.all([transaction.get(userRef), transaction.get(registryRef)]);
      if (registrySnapshot.exists && registrySnapshot.data().uid !== uid) throw new HttpsError('already-exists', 'Este nome já está em uso.');
      const profile = userSnapshot.exists ? userSnapshot.data() : {
        name: displayName, handle: (authUser.email || uid).split('@')[0].toLowerCase(), classId: '', schoolId: '', school: '', bio: '', avatar: '', banner: '',
        privacy: { profileVisible: true, showClass: false, showSchool: false, discoverable: true }, createdAt: Date.now(),
      };
      profile.name = displayName;
      transaction.set(userRef, profile, { merge: true });
      transaction.set(publicRef, {
        name: displayName, handle: profile.handle, bio: profile.bio || '', avatar: profile.avatar || '', banner: profile.banner || '',
        role: authUser.customClaims?.role || 'aluno', verified: Boolean(authUser.customClaims?.schoolVerified),
        profileVisible: profile.privacy?.profileVisible !== false, discoverable: profile.privacy?.discoverable !== false,
        classId: profile.privacy?.showClass ? profile.classId || '' : '', school: profile.privacy?.showSchool ? profile.school || '' : '',
        createdAt: profile.createdAt || Date.now(),
      }, { merge: true });
      if (!registrySnapshot.exists()) transaction.create(registryRef, { uid, createdAt: Date.now() });
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('internal', 'Não foi possível criar o perfil escolar.');
  }
  const currentClaims = authUser.customClaims || {};
  if (!currentClaims.role) await getAuth().setCustomUserClaims(uid, { ...currentClaims, role: 'aluno' });
  return { ok: true };
});

export const syncGroupCatalog = onDocumentWritten('groups/{groupId}', async event => {
  const ref = db.doc(`groupCatalog/${event.params.groupId}`);
  const after = event.data?.after;
  if (!after?.exists) { await ref.delete().catch(() => {}); return; }
  const group = after.data();
  await ref.set({
    name: group.name || '', description: group.description || '', visibility: group.visibility,
    category: group.category || 'Grupos', ownerId: group.ownerId || '', memberCount: (group.memberUids || []).length,
    updatedAt: Date.now(),
  });
});

export const updateProfileName = onCall(async request => {
  const uid = requireUser(request);
  const name = String(request.data?.name || '').trim();
  if (!/^[\p{L}]+(?:[ '\-][\p{L}]+){1,5}$/u.test(name)) throw new HttpsError('invalid-argument', 'Informe um nome completo plausível.');
  const key = nameKey(name);
  const userRef = db.doc(`users/${uid}`), publicRef = db.doc(`publicProfiles/${uid}`), nextRef = db.doc(`nameRegistry/${key}`);
  await db.runTransaction(async transaction => {
    const [userSnap, publicSnap, nextSnap] = await Promise.all([transaction.get(userRef), transaction.get(publicRef), transaction.get(nextRef)]);
    if (nextSnap.exists && nextSnap.data().uid !== uid) throw new HttpsError('already-exists', 'Este nome já está em uso.');
    const previousKey = nameKey(userSnap.data()?.name);
    if (previousKey && previousKey !== key) {
      const oldRef = db.doc(`nameRegistry/${previousKey}`);
      const oldSnap = await transaction.get(oldRef);
      if (oldSnap.exists && oldSnap.data().uid === uid) transaction.delete(oldRef);
    }
    transaction.set(nextRef, { uid, createdAt: Date.now() });
    transaction.update(userRef, { name, updatedAt: Date.now() });
    if (publicSnap.exists()) transaction.update(publicRef, { name, updatedAt: Date.now() });
  });
  return { ok: true };
});

export const createGroupInvite = onCall(async request => {
  const uid = requireUser(request);
  const groupId = String(request.data?.groupId || '');
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(groupId)) throw new HttpsError('invalid-argument', 'Grupo inválido.');
  const groupRef = db.doc(`groups/${groupId}`);
  const groupSnap = await groupRef.get();
  const group = groupSnap.data();
  requireManager(group, uid);
  if (group.visibility !== 'private') throw new HttpsError('failed-precondition', 'Convites são usados somente em grupos privados.');
  const code = randomBytes(6).toString('base64url').slice(0, 8).toUpperCase();
  const hash = sha256(code);
  await db.doc(`groupInvites/${hash}`).set({ groupId, createdBy: uid, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000, used: false });
  return { code, expiresAt: Date.now() + 10 * 60 * 1000 };
});

export const redeemGroupInvite = onCall(async request => {
  const uid = requireUser(request);
  const code = String(request.data?.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{6,12}$/.test(code)) throw new HttpsError('invalid-argument', 'Código inválido.');
  const inviteRef = db.doc(`groupInvites/${sha256(code)}`);
  let groupId = '';
  await db.runTransaction(async transaction => {
    const inviteSnap = await transaction.get(inviteRef);
    if (!inviteSnap.exists || inviteSnap.data().used || inviteSnap.data().expiresAt < Date.now()) throw new HttpsError('not-found', 'Código inválido ou expirado.');
    groupId = inviteSnap.data().groupId;
    const groupRef = db.doc(`groups/${groupId}`);
    const groupSnap = await transaction.get(groupRef);
    if (!groupSnap.exists || groupSnap.data().visibility !== 'private') throw new HttpsError('not-found', 'Grupo não disponível.');
    const group = groupSnap.data();
    if (!(group.memberUids || []).includes(uid)) {
      transaction.update(groupRef, {
        members: [...(group.members || []), { userId: uid, role: 'member', joinedAt: Date.now() }],
        memberUids: FieldValue.arrayUnion(uid),
      });
    }
    transaction.delete(inviteRef);
  });
  return { ok: true, groupId };
});

export const setSchoolRole = onCall(async request => {
  requireUser(request);
  if (!hasRole(request, ['administrador'])) throw new HttpsError('permission-denied', 'Somente o administrador principal pode alterar funções escolares.');
  const uid = String(request.data?.uid || '');
  const role = String(request.data?.role || '');
  const schoolVerified = Boolean(request.data?.schoolVerified);
  if (!uid || !['aluno', 'professor', 'secretaria', 'administrador'].includes(role)) throw new HttpsError('invalid-argument', 'Usuário ou função inválidos.');
  const target = await getAuth().getUser(uid);
  await getAuth().setCustomUserClaims(uid, { ...(target.customClaims || {}), role, schoolVerified });
  await db.doc(`publicProfiles/${uid}`).set({ role, verified: schoolVerified }, { merge: true });
  await db.collection('adminAudit').add({ actorId: request.auth.uid, action: 'school-role-updated', targetUid: uid, role, createdAt: Date.now() });
  return { ok: true };
});

export const reviewReport = onCall(async request => {
  requireStaff(request);
  const reportId = String(request.data?.reportId || '');
  const status = String(request.data?.status || '');
  if (!reportId || !['Em análise', 'Resolvida', 'Rejeitada'].includes(status)) throw new HttpsError('invalid-argument', 'Estado ou denúncia inválidos.');
  const ref = db.doc(`reports/${reportId}`);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new HttpsError('not-found', 'Denúncia não encontrada.');
    transaction.update(ref, { status, reviewedAt: Date.now(), reviewedBy: request.auth.uid });
    transaction.set(db.collection('adminAudit').doc(), { actorId: request.auth.uid, action: 'report-status-updated', targetId: reportId, status, createdAt: Date.now() });
  });
  return { ok: true };
});

export const deletePost = onCall(async request => {
  const uid = requireUser(request);
  const postId = String(request.data?.postId || '');
  const ref = db.doc(`posts/${postId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { ok: true };
  if (snapshot.data().authorId !== uid && !hasRole(request, ['administrador'])) throw new HttpsError('permission-denied', 'Você não pode excluir esta publicação.');
  await db.recursiveDelete(ref);
  return { ok: true };
});

export const deleteGroup = onCall(async request => {
  const uid = requireUser(request);
  const groupId = String(request.data?.groupId || '');
  const ref = db.doc(`groups/${groupId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists) return { ok: true };
  requireManager(snapshot.data(), uid);
  if (snapshot.data().ownerId !== uid) throw new HttpsError('permission-denied', 'Somente a pessoa responsável pode excluir o grupo.');
  await db.recursiveDelete(ref);
  return { ok: true };
});

