# Publicar o CONecta V2

Este pacote publica o front-end no **Firebase Hosting** e o back-end nas **Cloud Functions for Firebase**, com regras do Firestore e Storage. Enviar o repositório ao GitHub, sozinho, não ativa as funções: o workflow abaixo faz o deploy no seu projeto Firebase.

## 1. Preparar o projeto Firebase

No Firebase Console, crie um projeto e um app Web. Ative **Authentication → E-mail/senha**, crie o banco **Cloud Firestore** e ative **Storage**. Copie a configuração do app Web para `services/firebase-config.js`; são valores públicos de configuração, nunca coloque nesse arquivo uma chave de conta de serviço.

Para publicar Cloud Functions, o projeto Firebase precisa de faturamento habilitado (plano Blaze), mesmo que o uso permaneça dentro das cotas gratuitas. Sem isso, a opção de publicar somente o site é:

```bash
firebase deploy --only hosting --project SEU_FIREBASE_PROJECT_ID
```

Esse comando não publica o back-end. Para o CONecta completo, habilite o faturamento e siga as etapas de deploy completo.

## 2. Publicar automaticamente ao enviar para o GitHub

1. Extraia o ZIP e envie **todo o conteúdo da pasta** para um repositório GitHub.
2. Use a branch `main` ou altere o nome da branch no arquivo `.github/workflows/firebase-deploy.yml`.
3. No Firebase Console/Google Cloud, crie uma conta de serviço autorizada a publicar os recursos Firebase necessários e baixe o JSON dela. Não envie esse JSON ao repositório.
4. No GitHub, abra **Settings → Secrets and variables → Actions → New repository secret** e crie:
   - `FIREBASE_PROJECT_ID`: o ID do projeto Firebase, por exemplo `conecta-escola-123`.
   - `FIREBASE_SERVICE_ACCOUNT`: todo o conteúdo do JSON da conta de serviço.
5. Envie um commit para `main` ou execute **Actions → Publicar CONecta V2 no Firebase → Run workflow**.
6. Acompanhe o log da execução em **Actions**. O workflow valida o JavaScript, executa os testes, compila a pasta `site` e publica Hosting, Functions e regras. Se falhar, o passo vermelho do log mostra a causa.

As permissões da conta de serviço e a configuração de faturamento pertencem ao projeto Google/Firebase. Não compartilhe nem registre a chave privada da conta de serviço em mensagens ou arquivos do site.

## 3. Publicar manualmente pelo computador

Requisitos: Node.js 22 ou superior, npm e Firebase CLI.

```bash
npm install --global firebase-tools
npm install --prefix functions
```

Copie `.firebaserc.example` para `.firebaserc` e troque `SEU_FIREBASE_PROJECT_ID` pelo ID real. Depois, na pasta do projeto:

```bash
npm run check
npm test
npm run build
firebase login
firebase deploy --project SEU_FIREBASE_PROJECT_ID
```

O deploy completo pode solicitar configuração de faturamento e permissões no Console/Google Cloud na primeira publicação das Functions. Para uma simulação local dos serviços:

```bash
npm install --prefix functions
firebase emulators:start --only auth,functions,firestore,storage,hosting
```

## 4. Executar o site localmente

O projeto não usa dependências de front-end. Com Node.js instalado:

```bash
node scripts/serve.mjs
```

Abra `http://127.0.0.1:4173`. Também pode executar `npm run dev`. Não abra `index.html` diretamente com `file://`.

Sem preencher `services/firebase-config.js`, o site abre a demonstração local e exibe essa condição na interface. Isso não é uma sessão real nem sincroniza dados. Quando as credenciais do app Web forem preenchidas e os serviços estiverem habilitados, o site mostra a tela de autenticação Firebase.

## 5. API de Libras

O adaptador está em `services/libras.js`; detalhes e locais de configuração ficam em `integrations/libras/README.md`. A integração está **desativada** até você escolher a API e obter seu contrato. Mantenha a chave como segredo do Firebase Functions (`firebase functions:secrets:set LIBRAS_API_KEY`) e faça chamadas somente no servidor. Não coloque a chave no front-end, no ZIP nem no GitHub.

## Erros comuns

- **O GitHub aceita o commit, mas não publica o site:** GitHub armazena o código. Confira se o workflow terminou em verde na aba **Actions** e se os dois secrets estão configurados.
- **A publicação rejeita as Functions:** confira o projeto selecionado, permissões da conta de serviço, faturamento Blaze e se `npm install --prefix functions` terminou sem erro. Sem faturamento, publique temporariamente com `firebase deploy --only hosting` sabendo que o backend não estará ativo.
- **Página em branco ou sem estilo:** use o diretório `site` gerado por `npm run build` para hospedagem estática; para Firebase Hosting, deixe o workflow executar o build. Os caminhos dos assets são relativos e a página agora mostra um diagnóstico se o módulo JavaScript falhar. Abra o console do navegador e confira o arquivo apontado pelo erro.
- **Erro de projeto não encontrado:** use o ID do projeto, não o nome de exibição do Console. No deploy manual, confira `.firebaserc`; no GitHub, confira `FIREBASE_PROJECT_ID`.
- **Deploy completo funciona, mas o login falha:** preencha o app Web em `services/firebase-config.js`, habilite o provedor e confira as regras no Firebase Console. A publicação do site não cria nem configura o projeto Firebase por você.
- **Atualizei os arquivos, mas vejo a versão anterior:** confira a execução mais recente em **Actions**, atualize a página sem cache e confirme o domínio Hosting do projeto Firebase.

## Limites antes de uso escolar real

Este pacote não contém credenciais de Firebase e não foi publicado. A configuração e as regras precisam ser revisadas no projeto que você criar. A 2FA e a API de Libras ainda precisam de configuração; as opções dependem dos provedores escolhidos. O deploy não representa, por si só, conformidade com a LGPD nem substitui validações com usuários, leitores de tela ou em dispositivos móveis.
