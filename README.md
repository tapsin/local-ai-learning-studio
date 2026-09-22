# Local AI Studio

Yerel öncelikli RAG ve model fine-tuning masaüstü uygulaması. Arayüz Electron + React + TypeScript ile hazırlanır.

## Geliştirme

```bash
npm install
npm run dev
# ikinci terminal
npm start
```

## Paketleme

```bash
npm run dist:linux   # Linux AppImage
npm run dist:windows # Windows NSIS .exe (Windows üzerinde paketlenmesi önerilir)
```

## Veri şablonları

Uygulama içindeki “Yeni çalışma oluştur” bölümünden boş CSV veya Excel şablonunu indirebilirsiniz.

- RAG sütunları: `text` (zorunlu), `metadata`, `source`.
- Fine-tuning sütunları: `instruction`, `input`, `output` (`instruction` ve `output` zorunlu).

RAG indeksi, kaynaklı benzerlik araması ve isteğe bağlı yerel modelle yanıt üretimi ile QLoRA fine-tuning işleri yerel Python worker üzerinden yürütülür. Yerel yanıt seçeneği için Transformers destekli bir sohbet modelini Hugging Face’ten indirin. GGUF dosyaları Transformers ile yanıt üretiminde kullanılamaz. Cevap kalitesi seçilen modele ve kaynakların uygunluğuna bağlıdır; yanıtlar kaynak kartlarıyla kontrol edilmelidir. QLoRA model/VRAM uyumluluğuna bağlıdır. Hugging Face indirmesi büyük model depolarında disk alanı ve ağ gerektirir; gated/private modeller token ister.

Token Electron userData klasöründeki ayar dosyasında kullanıcıya özel izinlerle saklanır. Üretim sürümünde işletim sisteminin güvenli credential store (keychain/credential vault) entegrasyonuna geçirilmesi önerilir.

## Belgeden eğitim CSV’si oluşturma

Sol menüdeki Belge dönüştürücü PDF, DOC/DOCX, XLS/XLSX, TXT, RTF, MD ve CSV dosyalarını instruction/input/output CSV satırlarına dönüştürür. PDF metin tabanlı olmalıdır; taranmış sayfalarda OCR bu sürümde desteklenmez. Eski DOC dosyaları Antiword gerektirir; yoksa DOCX biçimine dönüştürüp yeniden deneyin. Kaynak dosya sınırı 25 MB, çıkarılan metin sınırı 5.000.000 karakterdir. Metin otomatik parçalara ayrılır ve API’ye sırayla gönderilir; ilerleme toplam parça üzerinden gösterilir.

Dönüştürücü OpenAI uyumlu chat-completions API kullanır. API adresi ve model yerel ayarlara kaydedilir. API anahtarı diske kaydedilmez; uygulama açıkken bellekte tutulur. Belge metni yalnızca açık onay verildiğinde belirtilen sağlayıcıya gönderilir ve kullanım ücret doğurabilir. Hassas/hukuki belgeleri göndermeden önce sağlayıcının veri politikasını inceleyin. CSV çıktısı ana eğitim ekranındaki fine-tuning ile uyumlu instruction,input,output sütunlarını taşır.

## Yerel AI çalışma ortamı

İlk RAG işi CPU uyumlu Python sanal ortamını ve embedding bağımlılıklarını kurar. Embedding modeli çevrim içiyken indirilip Hugging Face önbelleğinde tutulur; indeksleme ve sorgu sırasında dış ağa model indirme yapılmaz. Fine-tuning ayrı bir hazır olma durumuna sahiptir ve sonradan CUDA eğitim paketlerini ayrıca yükler. Bu ilk indirme internet erişimi ve birkaç GB boş disk alanı gerektirebilir. Fine-tuning seçeneği ayrıca CUDA uyumlu NVIDIA PyTorch kurar; model ve eğitim verisi yerel makinede işlenir. Eğitim çıktı klasörü uygulama userData alanındaki `training-output` altındadır. RAG koleksiyonları userData içindeki `knowledge-bases` altına yazılır.

Linux AppImage oluşturma/çalıştırma Linux ortamında doğrulanmalıdır. Windows installer için `.github/workflows/windows.yml` içindeki GitHub Actions iş akışını çalıştırabilir veya Windows üzerinde `npm run dist:windows` kullanabilirsiniz. Bu Linux ortamında NSIS 3.0.4.1 derleyicisi `!addincludedir` komutunu tanımadığı için `.exe` kurulumu üretilemedi; Windows iş akışının sonucu bu ortamda henüz doğrulanmadı.
