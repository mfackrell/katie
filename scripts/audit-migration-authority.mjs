#!/usr/bin/env node
// Read-only migration provenance audit. This script NEVER writes or replays SQL.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const url=process.env.DATABASE_URL;
if(!url){console.error("DATABASE_URL required");process.exit(2)}
function readRows(sql){
 const p=spawnSync("psql",[url,"-t","-A","-v","ON_ERROR_STOP=1","-c",`select coalesce(json_agg(t),'[]'::json) from (${sql}) t`],{encoding:"utf8",timeout:30000});
 if(p.status!==0)throw Error("Migration history query failed: "+(p.stderr||p.error?.message||"unknown").slice(0,500));
 return JSON.parse(p.stdout.trim());
}
const dir=join(process.cwd(),"supabase","migrations");
const files=readdirSync(dir).filter(x=>x.endsWith(".sql")).sort();
const expected=new Map(files.map(filename=>[filename,createHash("sha256").update(readFileSync(join(dir,filename))).digest("hex")]));
const custom=readRows("select filename,checksum from public.schema_migrations order by filename");
const native=readRows("select version,name from supabase_migrations.schema_migrations order by version");
const entries=new Map(custom.map(x=>[x.filename,x.checksum]));
const absent=files.filter(x=>!entries.has(x));
const altered=files.filter(x=>entries.has(x)&&entries.get(x)!==expected.get(x));
const legacyOnly=custom.filter(x=>!expected.has(x.filename)).map(x=>x.filename);
const nativeAliases={
 message_reactions:"20261023180000_message_reactions.sql",
 actor_reaction_events:"20261023194500_actor_reaction_events.sql",
 reaction_reply_jobs:"20261023205000_reaction_reply_jobs.sql"
};
const mappedNative=native.filter(x=>nativeAliases[x.name]).map(x=>({
 version:x.version,name:x.name,repositoryFile:nativeAliases[x.name],verifiedInCustom:entries.has(nativeAliases[x.name])
}));
const summary={authority:"public.schema_migrations via GitHub Actions migrate.yml",repoFiles:files.length,customEntries:custom.length,nativeEntries:native.length,missingCustom:absent,checksumMismatch:altered,historicalOnly:legacyOnly,mappedNative,unmappedNative:native.filter(x=>!nativeAliases[x.name]).length};
console.log(JSON.stringify(summary,null,2));
if(altered.length){console.error("Historical migration checksum mismatch; refuse deployment.");process.exit(1)}\n// Missing ledger records are legitimately pending new migrations on main.
// Native Supabase history is independent historical evidence, not a second write authority.
// Do not modify native history based on inferred name/timestamp matching.
