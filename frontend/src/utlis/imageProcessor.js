/**
 * 处理图片并触发下载，将图片保存到本地（模拟放到 assets 目录）
 * 注意：浏览器环境中无法直接写入本地文件系统，只能触发下载
 * @param {string} imageUrl - 图片 URL
 * @param {string} filename - 保存时的文件名，例如 "sample.png"
 * @returns {Promise<string>} 返回下载文件的文件名（如果需要）
 */
export async function downloadProcessedImage(imageUrl, filename) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // 设置跨域属性（需要服务器允许 CORS）
      img.crossOrigin = "anonymous";
      img.src = imageUrl;
      img.onload = () => {
        // 创建 canvas 并绘制图片
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
  
        // 在这里你可以加入其它图片处理逻辑（例如背景移除、裁剪等）
  
        // 转换为 Blob 并触发下载
        canvas.toBlob((blob) => {
          if (blob) {
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            resolve(filename);
          } else {
            reject(new Error("转换 Blob 失败"));
          }
        }, "image/png");
      };
      img.onerror = () => {
        reject(new Error("图片加载失败"));
      };
    });
  }