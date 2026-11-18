import {readdirSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const ts=createRequire(new URL('../../apps/web/package.json',import.meta.url))('typescript');
/** Source inventory only: loading this module never mounts a view or starts a browser. */
export function mountedRegressionInventory(){
 const files=readdirSync(path.join(root,'tests'),{recursive:true}).filter(name=>name.endsWith('-mounted.tsx')).map(name=>'tests/'+name.split(path.sep).join('/')).sort();
 return files.flatMap(file=>{
  const ast=ts.createSourceFile(file,readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),names=[];
  for(const node of ast.statements){
   if(!node.modifiers?.some(modifier=>modifier.kind===ts.SyntaxKind.ExportKeyword))continue;
   if(ts.isFunctionDeclaration(node)&&node.name)names.push(node.name.text);
   else if(ts.isVariableStatement(node))for(const declaration of node.declarationList.declarations){
    if(ts.isIdentifier(declaration.name)&&declaration.initializer&&(ts.isArrowFunction(declaration.initializer)||ts.isFunctionExpression(declaration.initializer)))names.push(declaration.name.text);
   }
  }
  return names.length?[{file,names:names.sort()}]:[];
 });
}
export function mountedRegressionEntryImports(){
 const entry='tests/shared/mounted-regressions.tsx',ast=ts.createSourceFile(entry,readFileSync(path.join(root,entry),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 return ast.statements.filter(node=>ts.isImportDeclaration(node)&&ts.isStringLiteral(node.moduleSpecifier)&&node.moduleSpecifier.text.endsWith('-mounted.tsx')).map(node=>path.relative(root,path.resolve(root,'tests/shared',node.moduleSpecifier.text)).split(path.sep).join('/')).sort();
}
