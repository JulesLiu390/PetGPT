const { ipcMain } = require('electron');
const { exec } = require('child_process');


// 监听来自渲染进程的 "say-hello" 消息
ipcMain.on('say-hello', (event, command) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`执行出错: ${error}`);
        return;
      }
      console.log(`输出: ${stdout}`);
    });
  });