const fs = require('fs');
const path = require('path');

function fileExistsRules(projectPath) {
  const files = ['README.md', 'package.json', 'LICENSE'];
  return files.map(file => ({
    name: `file_exists_${file.replace('.', '_')}`,
    description: `Checks that the file ${file} exists in the project path`,
    predicate: () => fs.existsSync(path.join(projectPath, file))
  }));
}

function directoryExistsRules(projectPath) {
  const dirs = ['src', 'test', 'docs'];
  return dirs.map(dir => ({
    name: `directory_exists_${dir}`,
    description: `Checks that the directory ${dir} exists in the project path`,
    predicate: () => fs.existsSync(path.join(projectPath, dir))
  }));
}

function standardProjectRules(projectPath) {
  return [...fileExistsRules(projectPath), ...directoryExistsRules(projectPath)];
}

module.exports = {
  fileExistsRules,
  directoryExistsRules,
  standardProjectRules
};
