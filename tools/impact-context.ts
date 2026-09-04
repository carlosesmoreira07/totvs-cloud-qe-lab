import { execFileSync } from 'node:child_process';

function gitLines(args: string[]): string[] {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const baseRef = process.env.QE_IMPACT_BASE_REF;
const changedFiles = new Set<string>([
  ...(baseRef ? gitLines(['diff', '--name-only', `${baseRef}...HEAD`]) : gitLines(['diff', '--name-only'])),
  ...gitLines(['diff', '--cached', '--name-only']),
  ...gitLines(['ls-files', '--others', '--exclude-standard']),
]);

const rules = [
  {
    pattern: /^specs\/openapi\//,
    risk: 'quebra de contrato ou mudança incompatível para consumidores',
    tests: ['npm run validate:openapi', 'npm run test:contract'],
    question: 'Status, headers, schemas e compatibilidade foram revisados junto do mock?',
  },
  {
    pattern: /^apps\/control-plane-mock\//,
    risk: 'divergência comportamental, duplicidade ou perda de diagnóstico',
    tests: ['npm run test:api', 'npm run test:contract'],
    question: 'A mudança preserva idempotência, correlação e transições observáveis?',
  },
  {
    pattern: /^tests\//,
    risk: 'redução silenciosa de cobertura ou evidência fraca',
    tests: ['npm test'],
    question: 'Cada controle ainda declara o risco e produz diagnóstico útil?',
  },
  {
    pattern: /^(docs\/|README\.md$|AGENTS\.md$)/,
    risk: 'hipótese apresentada como fato ou orientação divergente',
    tests: [],
    question: 'As afirmações usam [PUB], [VAGA], [LAB] ou [VALIDAR] e citam a fonte quando necessário?',
  },
];

const matched = rules.filter((rule) => [...changedFiles].some((file) => rule.pattern.test(file)));
const commands = [...new Set(matched.flatMap((rule) => rule.tests))];

console.log('# Contexto consultivo de impacto');
console.log('');
console.log('> Gerado deterministicamente. Não é decisão de release nem análise de um modelo.');
console.log('');
console.log('## Arquivos alterados');
if (changedFiles.size === 0) console.log('- Nenhuma mudança detectada.');
for (const file of [...changedFiles].sort()) console.log(`- \`${file}\``);
console.log('');
console.log('## Riscos candidatos');
if (matched.length === 0) console.log('- Nenhum mapeamento conhecido; revisão humana necessária.');
for (const rule of matched) console.log(`- ${rule.risk}`);
console.log('');
console.log('## Controles candidatos');
if (commands.length === 0) console.log('- Definir manualmente conforme o risco da mudança.');
for (const command of commands) console.log(`- \`${command}\``);
console.log('');
console.log('## Perguntas para revisão humana');
if (matched.length === 0) console.log('- Qual comportamento e qual risco esta mudança altera?');
for (const rule of matched) console.log(`- ${rule.question}`);

