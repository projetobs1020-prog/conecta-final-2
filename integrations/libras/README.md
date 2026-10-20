# Integrar a API de Libras

A interface já reserva o ponto de integração, mas nenhuma API externa está ativa. Ainda é necessário escolher o provedor e seguir a documentação dele para montar a requisição e interpretar a resposta. O site não envia texto para um serviço fictício.

## Onde configurar

- **URL do provedor:** mantenha no backend, em `functions/.env.<ID_DO_PROJETO>` como `LIBRAS_API_URL` (use `functions/.env.example` como modelo). Não coloque a URL em dados do usuário.
- **Chave da API:** cadastre como segredo do Firebase Functions com `firebase functions:secrets:set LIBRAS_API_KEY`. Não adicione essa chave a `services/firebase-config.js`, ao navegador, ao GitHub ou ao ZIP.
- **Código da integração:** implemente a chamada autenticada em uma Cloud Function de `functions/src/index.js` e conecte o adaptador `services/libras.js` a essa função. Valide tamanho e formato da entrada, limite chamadas, trate indisponibilidade e nunca registre a chave ou conteúdo sensível nos logs.

Antes de ativar, confirme com o provedor os campos requeridos, autenticação, limites, custos, formato da resposta, direitos de uso e se a API produz tradução em Libras, avatar, vídeo ou outro recurso. A tela de preferências informa que a integração está desativada até essa etapa.
