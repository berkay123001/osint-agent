import { compareImages } from './src/tools/phashCompareTool.js';

async function run() {
  console.log("TEST: Yalan Haber vs Gerçek Haber Görsel Eşleşmesi");
  
  const url1 = "https://raw.githubusercontent.com/ianare/exif-samples/master/jpg/gps/DSCN0010.jpg"
  const url2 = "https://raw.githubusercontent.com/ianare/exif-samples/master/jpg/gps/DSCN0010.jpg"
  
  const result = await compareImages(url1, url2);
  console.log(result);
}

run();
