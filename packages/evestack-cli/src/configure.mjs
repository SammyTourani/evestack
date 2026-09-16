import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { spawnSync } from "node:child_process";
import { findProjectEnv, notAProject, wantsHelp } from "./project.mjs";

const PUBLIC_KEYS = new Set([
  "EVESTACK_PROVIDER", "EVESTACK_MODEL", "EVESTACK_BASE_URL", "EVESTACK_CONTEXT_WINDOW", "OLLAMA_BASE_URL",
  "EVESTACK_EMBED_PROVIDER", "EVESTACK_EMBED_MODEL", "EVESTACK_EMBED_DIMENSIONS", "EVESTACK_MEMORY_SCOPE",
  "TELEGRAM_BOT_USERNAME", "TELEGRAM_ALLOWED_USER_IDS", "SLACK_ALLOWED_USER_IDS",
  "DISCORD_APPLICATION_ID", "DISCORD_ALLOWED_GUILD_IDS", "DISCORD_ALLOWED_USER_IDS", "EVESTACK_ALERT_WEBHOOK_FORMAT",
]);
const SECRET_KEYS = new Set([
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "EVESTACK_COMPATIBLE_API_KEY", "COMPOSIO_API_KEY",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET_TOKEN", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET",
  "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN", "EVESTACK_ALERT_WEBHOOK_URL", "EVESTACK_ALERT_WEBHOOK_SECRET",
]);
const MAX_FILE = 256 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const ENV_NAMES = [".env", ".env.local"];
const defaultBackupRoot = () => join(homedir(), ".evestack", "config-backups");

export const CONFIGURE_USAGE = `evestack configure — preview and safely save provider or channel settings

  evestack configure --set=EVESTACK_PROVIDER=openai --set=EVESTACK_MODEL=MODEL
  evestack configure --from-file=/private/settings.json [--json]
  evestack configure SAME_OPTIONS --apply --expect=PREVIEW_FINGERPRINT
  evestack configure --restore=BACKUP_ID [--apply --expect=PREVIEW_FINGERPRINT]

Preview is read-only. Apply checks the preview against current .env files, takes a
private backup outside the project, and atomically replaces the selected env file.
Use a JSON object for secrets; secret values on --set are refused to keep them out
of shell history. JSON null removes an override. Unrelated settings stay intact.

  --set=KEY=value          repeat for non-secret settings
  --from-file=PATH         JSON settings; regular file, at most 64 KiB
  --apply                 save the reviewed change (never restart services)
  --expect=HASH            fingerprint printed by the current preview
  --restore=BACKUP_ID      preview restoring one backup for this project
  --allow-public-channel  explicitly allow a wildcard channel allow-list
  --json                  machine-readable, with secrets redacted
  -h, --help              this

Restart the agent after saving. Recreate a compose dashboard if its environment
changed, then use evestack verify and a real task/delivery test. Saved configuration
is not evidence of activation, valid credentials or permissions in a custom agent.
`;

function readRegular(path, limit = MAX_FILE) {
  let info;
  try { info = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing a non-regular configuration file: ${basename(path)}.`);
  if (info.size > limit) throw new Error(`Configuration file exceeds ${limit} bytes.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = readFileSync(fd);
    if (bytes.length > limit) throw new Error("Configuration file grew beyond the size limit.");
    try { return new TextDecoder("utf-8",{fatal:true}).decode(bytes); } catch { throw new Error("Configuration files must be valid UTF-8 text."); }
  } finally { closeSync(fd); }
}

function safeEnv(raw) {
  const text = raw ?? "";
  const entries = new Map();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (entries.has(key)) throw new Error(`Duplicate ${key} assignments need manual review before configuring.`);
    if (/^["']/.test(value) && !/^(["']).*\1\s*(?:#.*)?$/.test(value))
      throw new Error(`Multiline or incomplete quoting in ${key} needs manual review.`);
    entries.set(key, index);
  }
  return { lines, entries, values: parseEnv(text), newline: text.includes("\r\n") ? "\r\n" : "\n" };
}

function validateSetting(key, value, allowPublic) {
  if (!/^[A-Z][A-Z0-9_]{0,100}$/.test(key)) throw new Error("Invalid configuration key.");
  if (!PUBLIC_KEYS.has(key) && !SECRET_KEYS.has(key)) throw new Error(`Unsupported setting ${key}. Edit it in the project's deployment configuration.`);
  if (value === null) return;
  if (typeof value !== "string" || value.length > 8192 || /[\x00-\x1f\x7f']/.test(value))
    throw new Error(`Invalid value for ${key}; use a single-line string without control characters or single quotes.`);
  if (/\$(?:[A-Za-z_{])/.test(value)) throw new Error(`Environment interpolation in ${key} needs manual review across the agent and dashboard loaders.`);
  const choices = {
    EVESTACK_PROVIDER: ["openai", "anthropic", "openrouter", "ollama", "compatible", "chatgpt"],
    EVESTACK_EMBED_PROVIDER: ["openai", "ollama"],
    EVESTACK_MEMORY_SCOPE: ["owner", "strict", "shared"],
    EVESTACK_ALERT_WEBHOOK_FORMAT: ["slack", "discord", "webhook"],
  };
  if (choices[key] && !choices[key].includes(value)) throw new Error(`Invalid ${key}. Allowed: ${choices[key].join(", ")}.`);
  if (["EVESTACK_CONTEXT_WINDOW", "EVESTACK_EMBED_DIMENSIONS"].includes(key) && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1000000))
    throw new Error(`Invalid positive integer for ${key}.`);
  if (["EVESTACK_BASE_URL", "OLLAMA_BASE_URL"].includes(key)) {
    let url;try { url = new URL(value); } catch { throw new Error(`Invalid URL for ${key}.`); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error(`${key} requires an http(s) URL without embedded credentials.`);
  }
  if (/ALLOWED_(USER|GUILD)_IDS$/.test(key) && value.split(",").map(v => v.trim()).includes("*") && !allowPublic)
    throw new Error(`${key} opens the channel to everyone. Use --allow-public-channel only if that is intended.`);
}

function gitSafety(dir, file) {
  const gitEnvironment={...process.env,GIT_TERMINAL_PROMPT:"0"};
  for(const key of ["GIT_DIR","GIT_WORK_TREE","GIT_INDEX_FILE","GIT_COMMON_DIR"])delete gitEnvironment[key];
  const run = (args) => spawnSync("git", ["-C",dir,...args], { encoding:"utf8", timeout:5000, env:gitEnvironment });
  const repo = run(["rev-parse","--is-inside-work-tree"]);
  if (repo.error) throw new Error("Could not check Git protection for the configuration file.");
  if (repo.status !== 0) {
    let cursor=dir;
    while(true){
      if(existsSync(join(cursor,".git")))throw new Error("Git could not inspect this repository. Fix repository access before saving configuration.");
      const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;
    }
    return;
  }
  if (run(["ls-files","--error-unmatch","--",file]).status === 0)
    throw new Error(`${file} is tracked by Git. Remove it from tracking and ignore it before saving configuration.`);
  if (run(["check-ignore","-q","--",file]).status !== 0)
    throw new Error(`Add ${file} to .gitignore before saving configuration so credentials cannot enter a commit.`);
}

// Windows does not implement POSIX 0600/0700. Apply an explicit owner-only ACL
// before a file containing credentials becomes the active configuration.
function protectWindowsPath(path, directory) {
  if (process.platform !== "win32") return;
  const script = `
    $ErrorActionPreference = 'Stop'
    $p = $env:EVESTACK_CONFIG_PRIVATE_PATH
    $who = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $current = Get-Acl -LiteralPath $p
    if ($current.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $who.Value) { throw 'Not owned by current user' }
    if ($env:EVESTACK_CONFIG_PRIVATE_DIRECTORY -eq '1') {
      $acl = New-Object System.Security.AccessControl.DirectorySecurity
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    } else {
      $acl = New-Object System.Security.AccessControl.FileSecurity
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($who,'FullControl','Allow')
    }
    $acl.SetOwner($who)
    $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $p -AclObject $acl
  `;
  const result = spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{
    encoding:"utf8",timeout:15000,
    env:{...process.env,EVESTACK_CONFIG_PRIVATE_PATH:path,EVESTACK_CONFIG_PRIVATE_DIRECTORY:directory?'1':'0'},
  });
  if (result.error || result.status !== 0) throw new Error("Could not protect configuration permissions with a Windows owner-only ACL. Nothing was activated.");
}

function privateDirectory(path) {
  if (!existsSync(path)) {
    const parent = dirname(path);
    if (!existsSync(parent)) privateDirectory(parent);
    mkdirSync(path, {mode:0o700});
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0) || (process.getuid && info.uid !== process.getuid()))
    throw new Error("The backup directory must be owned by you, private (0700), and not a symbolic link.");
  protectWindowsPath(path,true);
}

function atomicWrite(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}.evestack-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    protectWindowsPath(temporary,false);
    writeFileSync(fd,text);fsyncSync(fd);closeSync(fd);fd=undefined;
    renameSync(temporary,path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function configurationPlan(found, changes, {allowPublic = false, restore = null, backupRoot = defaultBackupRoot()} = {}) {
  const dir = realpathSync(found.dir);
  const before = Object.fromEntries(ENV_NAMES.map(name => [name,readRegular(join(dir,name))]));
  const file = before['.env.local'] !== null ? '.env.local' : '.env';
  if (before[file] === null) throw new Error("No project env file exists.");
  let next;
  let restoredFrom = null;
  if (restore) {
    if (!/^[a-f0-9-]{36}$/.test(restore)) throw new Error("Invalid backup id.");
    const raw = readRegular(join(backupRoot,hash(dir),`${restore}.json`),MAX_FILE * 2);
    if (raw === null) throw new Error("Backup not found for this project.");
    let backup;
    try { backup = JSON.parse(raw); } catch { throw new Error("The backup file is not valid JSON."); }
    if (backup.version !== 1 || backup.project !== dir || backup.file !== file || typeof backup.content !== "string" || backup.contentHash !== hash(backup.content))
      throw new Error("The backup does not match this project/file or failed its integrity check.");
    next = backup.content;restoredFrom = restore;
  } else {
    if (!changes || Array.isArray(changes) || typeof changes !== "object" || !Object.keys(changes).length || Object.keys(changes).length > 32)
      throw new Error("Provide between one and 32 settings as a JSON object or --set options.");
    const parsed = safeEnv(before[file]);
    for (const [key,value] of Object.entries(changes)) {
      validateSetting(key,value,allowPublic);
      if (parsed.values[key] === value || (value === null && parsed.values[key] === undefined)) continue;
      const index = parsed.entries.get(key);
      const replacement = value === null ? null : `${key}='${value}'`;
      if (index === undefined) { if (replacement !== null) parsed.lines.push(replacement); }
      else parsed.lines[index] = replacement;
    }
    next = parsed.lines.filter(line => line !== null).join(parsed.newline);
    if (!next.endsWith(parsed.newline)) next += parsed.newline;
  }
  const oldValues = safeEnv(before[file]).values, newValues = safeEnv(next).values;
  const keys = [...new Set([...Object.keys(oldValues),...Object.keys(newValues)])].filter(key => oldValues[key] !== newValues[key]).sort();
  if (keys.length === 0) next = before[file];
  for (const key of keys) if (/ALLOWED_(USER|GUILD)_IDS$/.test(key) && newValues[key] !== undefined) validateSetting(key,newValues[key],allowPublic);
  const display = (key,value) => value === undefined ? null : !PUBLIC_KEYS.has(key) ? "[redacted]" : /BASE_URL$/.test(key) ? "[configured URL]" : value.replace(/[\x00-\x1f\x7f]/g," ").slice(0,300);
  const fingerprint = hash(JSON.stringify({version:1,dir,before,file,next,restoredFrom}));
  const sourceHash = hash(JSON.stringify(before));
  return {
    dir,file,before,next,fingerprint,sourceHash,backupRoot,
    review: {
      project:dir,file,fingerprint,restoredFrom,
      changes:keys.map(key => ({key,action:oldValues[key]===undefined?'add':newValues[key]===undefined?'remove':'change',
        before:display(key,oldValues[key]),after:display(key,newValues[key])})),
      processOverrides:keys.filter(key => process.env[key] !== undefined && process.env[key] !== ''),
      activation:'Not activated. Restart the agent; recreate a dashboard whose environment changed. Then verify and test the relevant provider/channel.',
      notes:[
        'Only env configuration changes. Custom agent code and supervisor/container environments can override or ignore these values.',
        ...(keys.some(key=>key.startsWith('EVESTACK_EMBED_') || key==='EVESTACK_PROVIDER')?['Provider changes can change the embedding model. Back up memory and verify compatibility before activation; changing models requires re-embedding.']:[]),
        ...(keys.some(key=>/^(TELEGRAM|SLACK|DISCORD)_/.test(key))?['Channel files, provider-side webhooks and allow-lists must also be configured. Verify an inbound message from an allowed identity; this command sends nothing.']:[]),
        ...(keys.some(key=>key.startsWith('EVESTACK_ALERT_')||key==='COMPOSIO_API_KEY')?['Recreate the dashboard to load changed environment values, then check Connections and test receipt.']:[]),
        'Removing an override can expose a value in .env, the shell or the service environment. Backups retain old secrets until you remove them.',
      ],
    },
  };
}

export function applyConfiguration(plan, expected) {
  if (!expected || expected !== plan.fingerprint) throw new Error("The preview fingerprint changed or is missing. Review a fresh preview and pass its --expect value.");
  gitSafety(plan.dir,plan.file);
  const lock = join(plan.dir,`.${plan.file}.evestack-lock`);
  let fd;
  try {
    fd = openSync(lock,constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,0o600);
  } catch { throw new Error("Another configuration edit may be in progress. Inspect the env lock before retrying."); }
  try {
    const readState = () => Object.fromEntries(ENV_NAMES.map(name=>[name,readRegular(join(plan.dir,name))]));
    if (hash(JSON.stringify(readState())) !== plan.sourceHash) throw new Error("Project configuration changed after preview. Nothing was applied.");
    if (plan.next === plan.before[plan.file]) return {...plan.review,applied:false,backupId:null};
    const root = resolve(plan.backupRoot);
    let ancestor=root;const suffix=[];
    while(!existsSync(ancestor)){suffix.unshift(basename(ancestor));ancestor=dirname(ancestor);}
    const actualRoot=resolve(realpathSync(ancestor),...suffix);
    const inside=relative(plan.dir,actualRoot);
    if (!inside || (inside !== ".." && !inside.startsWith(".."+sep) && !isAbsolute(inside))) throw new Error("Backups must be outside the project so old credentials cannot be committed.");
    privateDirectory(root);
    const location = join(root,hash(plan.dir));privateDirectory(location);
    const backupId = randomUUID();
    const backup = {version:1,project:plan.dir,file:plan.file,content:plan.before[plan.file],contentHash:hash(plan.before[plan.file]),createdAt:new Date().toISOString()};
    const backupFd = openSync(join(location,`${backupId}.json`),constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,0o600);
    try { writeFileSync(backupFd,JSON.stringify(backup));fsyncSync(backupFd); } finally { closeSync(backupFd); }
    if (hash(JSON.stringify(readState())) !== plan.sourceHash) throw new Error("Project configuration changed while backing up. Nothing was applied.");
    atomicWrite(join(plan.dir,plan.file),plan.next);
    return {...plan.review,applied:true,backupId,backupDirectory:location};
  } finally { closeSync(fd);unlinkSync(lock); }
}

export async function configure(argv, {stdout=process.stdout,stderr=process.stderr,cwd=process.cwd(),backupRoot} = {}) {
  if (wantsHelp(argv)) { stdout.write(CONFIGURE_USAGE);return 0; }
  try {
    let fromFile,restore,expected,apply=false,json=false,allowPublic=false;
    const assignments=[];
    for (const arg of argv) {
      if (arg==='--apply') apply=true;
      else if (arg==='--json') json=true;
      else if (arg==='--allow-public-channel') allowPublic=true;
      else if (arg.startsWith('--set=')) assignments.push(arg.slice(6));
      else if (arg.startsWith('--from-file=')) fromFile=arg.slice(12);
      else if (arg.startsWith('--restore=')) restore=arg.slice(10);
      else if (arg.startsWith('--expect=')) expected=arg.slice(9);
      else throw new Error("Unknown configure option. Run evestack configure --help.");
    }
    if (restore && (fromFile || assignments.length)) throw new Error("Restore cannot be combined with new settings.");
    const found=findProjectEnv(cwd);if(!found)return notAProject(stderr);
    let changes={};
    if(fromFile){const raw=readRegular(resolve(cwd,fromFile),65536);if(raw===null)throw new Error('Settings file not found.');try{changes=JSON.parse(raw);}catch{throw new Error('Settings file must be a JSON object.');}}
    if(!changes || typeof changes!=='object' || Array.isArray(changes))throw new Error('Settings file must be a JSON object.');
    for(const assignment of assignments){const at=assignment.indexOf('=');if(at<1)throw new Error('Use --set=KEY=value.');const key=assignment.slice(0,at);if(SECRET_KEYS.has(key))throw new Error(`Use --from-file for ${key}; secrets do not belong in shell history.`);if(Object.hasOwn(changes,key))throw new Error(`Duplicate setting ${key}.`);Object.defineProperty(changes,key,{value:assignment.slice(at+1),enumerable:true,configurable:true});}
    const plan=configurationPlan(found,changes,{allowPublic,restore,...(backupRoot?{backupRoot}:{})});
    const result=apply?applyConfiguration(plan,expected):{...plan.review,applied:false};
    if(json)stdout.write(JSON.stringify(result,null,2)+'\n');
    else {
      stdout.write(`${result.applied?'Saved':'Preview'} ${result.file}\n`);
      for(const change of result.changes)stdout.write(`  ${change.action} ${change.key}: ${change.before??'(unset)'} → ${change.after??'(unset)'}\n`);
      stdout.write(`Fingerprint: ${result.fingerprint}\n`);
      if(!apply)stdout.write('Apply with the same options plus --apply --expect='+result.fingerprint+'\n');
      if(result.backupId)stdout.write(`Backup: ${result.backupId}\nRestore preview: evestack configure --restore=${result.backupId}\n`);
      if(result.processOverrides.length)stdout.write('Shell overrides: '+result.processOverrides.join(', ')+'\n');
      stdout.write(result.activation+'\n');
      for(const note of result.notes)stdout.write(note+'\n');
      stdout.write('Next: evestack verify, then inspect a real task or channel delivery.\n');
    }
    return 0;
  } catch(error) { stderr.write(`Configuration was not confirmed: ${error.message}\n`);return 1; }
}
