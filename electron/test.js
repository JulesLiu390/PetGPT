const { exec } = require('child_process');

// 使用 open 命令打开计算器应用
exec('open -a Calculator', (error, stdout, stderr) => {
  if (error) {
    console.error(`执行出错: ${error}`);
    return;
  }
  console.log(`输出: ${stdout}`);
});