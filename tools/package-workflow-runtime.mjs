import {createRequire} from 'node:module';
import {cpSync,mkdirSync,readFileSync,writeFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [source,target,commit]=process.argv.slice(2);
const req=createRequire(join(resolve(source),'package.json'));
mkdirSync(target,{recursive:false});
cpSync(join(source,'lib'),join(target,'lib'),{recursive:true});
cpSync(join(source,'package.json'),join(target,'package.json'));
for(const name of ['skills','prompts','locale','cordis.patch.yml'])cpSync(join(source,name),join(target,name),{recursive:true});
const packages=new Map();
function copy(name,parent){
 let file;try{file=parent.resolve(name+'/package.json');}catch{let dir=dirname(parent.resolve(name));while(dir!=='/'){const candidate=join(dir,'package.json');if(existsSync(candidate)&&JSON.parse(readFileSync(candidate)).name===name){file=candidate;break;}dir=dirname(dir);}if(!file)throw Error('No package root for '+name);}
 const pkg=JSON.parse(readFileSync(file));
 if(packages.has(name)){if(packages.get(name).version!==pkg.version)throw Error('Multiple versions require nested resolution: '+name);return;}
 const to=join(target,'node_modules',name);mkdirSync(dirname(to),{recursive:true});
 cpSync(dirname(file),to,{recursive:true,dereference:true});packages.set(name,{version:pkg.version});
 const child=createRequire(file);for(const dependency of Object.keys(pkg.dependencies||{}))copy(dependency,child);
}
for(const name of ['ajv','effect','proper-lockfile','zod','@deepseek-ai/schemastery'])copy(name,req);
const files={};function walk(root){for(const entry of readdirSync(root)){const p=join(root,entry),s=lstatSync(p);if(s.isSymbolicLink())throw Error('Nonimmutable symlink '+p);if(s.isDirectory())walk(p);else files[p.slice(target.length+1)]={size:s.size,sha256:createHash('sha256').update(readFileSync(p)).digest('hex')};}}
walk(target);writeFileSync(join(target,'manifest.json'),JSON.stringify({sourceCommit:commit,purpose:'Unselected native Workflow Source release, no daemon or profile selection',packages:Object.fromEntries(packages),files},null,2)+'\n');
console.log(JSON.stringify({target,packages:packages.size,files:Object.keys(files).length,manifestSha256:createHash('sha256').update(readFileSync(join(target,'manifest.json'))).digest('hex')}));
