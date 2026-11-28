import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,writeFileSync,mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';

// The historical application must stay byte-for-byte intact. Only the exact
// unchanged legacy test fixture may receive this transport-only correction.
// A candidate-modified fixture is never replaced; all other tests run normally.
export const legacyFixturePath="tests/standalone-uncertain-continuation-postgres.test.mjs";
export const legacyFixtureBlob='1b6d3d75d60625bdb2f9d092603faeccea9e7221';
export const correctedFixtureBlob="225600cb6b839a80b8bea19a940108a96811ac81";
export function gitBlobHash(bytes){
 const b=Buffer.from(bytes);
 return createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
}
export function fixLegacyPostgresFixture(bytes){
 if(gitBlobHash(bytes)!==legacyFixtureBlob)throw Error('Unrecognized legacy PostgreSQL test fixture');
 let source=Buffer.from(bytes).toString('utf8');
 const changes=[
  [
    "import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';",
    "import {mkdtempSync,readFileSync,rmSync,existsSync,appendFileSync,realpathSync} from 'node:fs';\nimport {createServer} from 'node:net';\nimport {once} from 'node:events';"
  ],
  [
    "const connections=[];let started=false;",
    "const connections=[];let started=false,port;"
  ],
  [
    "host:'127.0.0.1',port:55502,user:'postgres',database:'postgres'",
    "host:dir,port,user:'postgres',database:'postgres',connectionTimeoutMillis:5000"
  ],
  [
    "  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-o',\"-h 127.0.0.1 -k '' -p 55502\",'-w','start']);started=true;\n  const admin=await connect();",
    "  // Ask the OS for a dynamic port number. PostgreSQL uses only a private\n  // Unix socket under this cluster's mkdtemp directory, never a TCP listener.\n  // The unique directory makes reuse of the numeric port collision-proof.\n  const probe=createServer();\n  try{\n   probe.listen(0,'127.0.0.1');await once(probe,'listening');port=probe.address().port;\n  }finally{if(probe.listening)await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));}\n  const socketDir=dir.replaceAll('\\\\','\\\\\\\\').replaceAll(\"'\",\"''\");\n  appendFileSync(join(data,'postgresql.conf'),\"\\nlisten_addresses = ''\\nport = \"+port+\"\\nunix_socket_directories = '\"+socketDir+\"'\\n\");\n  run('pg_ctl',['-D',data,'-l',join(dir,'log'),'-w','start']);started=true;\n  const admin=await connect();\n  const identity=(await admin.query(\"select current_setting('data_directory') as directory,current_setting('port')::int as port,inet_server_addr() is null as private_socket\")).rows[0];\n  assert.deepEqual(identity,{directory:realpathSync(data),port,private_socket:true},'Client must connect to this exact isolated fixture');\n  console.log('ISOLATED_POSTGRES_ENDPOINT '+JSON.stringify({directory:identity.directory,port}));"
  ],
  [
    "if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);",
    "if(started||existsSync(join(data,'postmaster.pid')))run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);"
  ]
];
 for(const [before,after] of changes){
  if(source.split(before).length!==2)throw Error('Legacy fixture transport correction mismatch');
  source=source.replace(before,after);
 }
 if(gitBlobHash(source)!==correctedFixtureBlob)throw Error('Corrected test fixture identity mismatch');
 return source;
}
export function prepareLegacyPostgresFixture({root,baseSha,tempRoot}){
 const git=(...args)=>execFileSync('git',['-c','core.fsmonitor=false',...args],{cwd:root,encoding:'utf8',timeout:10000}).trim();
 const expected='100644 blob '+legacyFixtureBlob+'\t'+legacyFixturePath;
 if(git('ls-tree',baseSha,'--',legacyFixturePath)!==expected||git('ls-tree','HEAD','--',legacyFixturePath)!==expected)return null;
 const source=resolve(root,legacyFixturePath),dir=realpathSync(root),trusted=realpathSync(tempRoot);
 if(trusted===dir||trusted.startsWith(dir+'/'))throw Error('Fixture overlay must be outside candidate checkout');
 const parent=lstatSync(resolve(root,'tests')),file=lstatSync(source);
 if(!parent.isDirectory()||parent.isSymbolicLink()||!file.isFile()||file.isSymbolicLink())throw Error('Legacy fixture is not a regular tracked file');
 const corrected=fixLegacyPostgresFixture(readFileSync(source));
 const scratch=mkdtempSync(resolve(trusted,'project-pg-fixture-'));
 try{
  const overlay=resolve(scratch,'isolated-postgres.test.mjs');
  writeFileSync(overlay,corrected,{mode:0o400,flag:'wx'});
  return {args:['--ro-bind',overlay,'/app/'+legacyFixturePath],cleanup:()=>rmSync(scratch,{recursive:true,force:true})};
 }catch(error){rmSync(scratch,{recursive:true,force:true});throw error;}
}
