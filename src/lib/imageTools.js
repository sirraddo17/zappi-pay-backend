// Shrinks a photo/screenshot on the phone before upload (fast on mobile
// data): max `maxW` pixels wide, JPEG, under about `maxKB`.
export function compressImage(file, { maxW = 1280, maxKB = 450 } = {}) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) {
      reject(new Error('Please choose a picture.'));
      return;
    }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.85;
      let data = c.toDataURL('image/jpeg', q);
      while (data.length > maxKB * 1370 && q > 0.35) {
        q -= 0.1;
        data = c.toDataURL('image/jpeg', q);
      }
      resolve(data);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that picture.')); };
    img.src = url;
  });
}
