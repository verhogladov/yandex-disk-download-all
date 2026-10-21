# Yandex Diskten episini nasıl yüklep almalı

Sade qılavuz. Tahminen beş daqqa vaqıt ala.

*Rus tilinden tercime — tüzetüvlerni [GitHub](https://github.com/verhogladov/yandex-disk-download-all/issues) vastasınen yiberseñiz, sağ oluñız.*

**Ne oldı.** 2026 senesi 11 oktâbrden berli Yandex Disk saytında papkanı, bir qaç faylnı ya da bütün Disk'ni birden yüklep almaq mümkün degil — tek birer-birer. «Yandex Diskten episini yüklep almaq» adlı parasız brauzer kenişletmesi «Yüklep almaq» dögmesini qaytara: o, fayllarnı birer-birer özü yükley ve Disktekiler kibi papkalarğa yerleştire.

**Ne kerek:**

- kompyuter ya da noutbuk (Windows, macOS ya da Linux);
- Google Chrome ya da Yandex Brauzer (Edge, Opera, Brave, Vivaldi de olur);
- kompyuterde boş yer — tahminen Diskte ne qadar yer tutulğan olsa, o qadar.

Telefonda işlemey: mobil brauzerlerge böyle kenişletme qurulmay. Kompyuter kerek.

## 1-nci adım. Kenişletmeni yüklep alıñız

1. Basıñız: **[yandex-disk-download-all.zip yüklep almaq](https://github.com/verhogladov/yandex-disk-download-all/releases/latest/download/yandex-disk-download-all.zip)**. Fayl «Загрузки» papkasına saqlanır.
2. Onı arhivden çıqarıñız:
   - **Windows:** faylğa sıçannıñ sağ dögmesinen basıñız → «Извлечь все…» (episini çıqarmaq) → «Извлечь»;
   - **macOS:** faylğa eki kere basıñız.
3. `yandex-disk-download-all` papkası peyda olur. Onı mania olmaycaq yerge, meselâ «Документы» papkasına avuştırıñız. Soñra silmeñiz: brauzer kenişletmeni bu papkadan ala.

## 2-nci adım. Kenişletmeni brauzerge qurıñız

**Google Chrome**

1. Adres satırına `chrome://extensions` yazıñız ve Enter basıñız.
2. Yuqarı sağ köşede **«Режим разработчика»** (inkişafçı rejimi, ingilizce Developer mode) şalterini açıñız.
3. Yuqarı sol köşedeki birinci dögmege basıñız — **«Загрузить распакованное расширение»** (açılğan kenişletmeni yüklemek, ingilizce Load unpacked).
   ![«Режим разработчика» (1) ve «Загрузить распакованное расширение» (2) qayda](../docs/guide-extensions.png)
4. `yandex-disk-download-all` papkasını saylañız (içinde `manifest.json` faylı olğan papka).
5. Cedvelde kenişletme peyda olur. Azır.

**Yandex Brauzer** — aynı öyle, tek adresi `browser://extensions`.

**Edge, Opera, Brave, Vivaldi** — adresler `edge://extensions`, `opera://extensions`, `brave://extensions`, `vivaldi://extensions`, soñra aynı öyle: «Режим разработчика» → «Загрузить распакованное».

> «Режим разработчика» — bu adiy şey: tükândan olmağan kenişletmeler böyle qurula. Kenişletme parasız, kodu açıq. Eger brauzer işke tüşkende böyle kenişletmelerni söndürmekni teklif etse — red etiñiz.

## 3-nci adım. «Qayda saqlamalı» sualini söndüriñiz

Yoqsa brauzer er fayl aqqında sorar, olar ise biñlernen ola bile.

- **Chrome:** `chrome://settings/downloads` açıñız ve **«Перед скачиванием спрашивать, куда сохранить файл»** (er faylnı qayda saqlamaq kerek olğanını sorav) degenini söndüriñiz.
  ![Şalter söndürilgen olmalı](../docs/guide-downloads.png)
- **Yandex Brauzer:** «Настройки» → «Инструменты» → «Загруженные файлы» → **«Всегда спрашивать, куда сохранять файлы»** belgisini çıqarıñız.
- **Diger brauzerler:** sazlamalarnıñ yüklemeler bölüginde er faylnı qayda saqlamaq aqqındaki sualni söndüriñiz.

## 4-nci adım. Fayllarnı yüklep alıñız

1. [disk.yandex.ru](https://disk.yandex.ru) açıñız ve akkauntıñızğa kiriñiz. Disk evelden açıq olsa — saifeni yañartıñız (F5).
2. Aşağı sağ köşede mavı **«Bütün Disk'ni yüklep almaq»** dögmesi peyda olur. Papka içinde o «Papkanı yüklep almaq» dep adlana, fayllarnı belgileseñiz ise — «Belgilengenni yüklep almaq».
   ![Diskteki mavı dögme](../docs/guide-button.png)
3. Oña basıñız. Pencere açılır:
   - **«Neni yüklep almalı»** — bütün Disk, bu papka, belgilengenler ya da cedvelden «Fayllar ve papkalarnı saylamaq…»;
   - **«Qaysı fayllar»** — episi ya da «Tek kerekli çeşitler» (meselâ, tek fotoresim ve video);
   - **«Qayda saqlamalı»** — kompyuterge Disktekiler kibi fayllar olaraq, bir ZIP-arhiv olaraq ya da başqa bulutqa.
4. **«Yüklevni başlamaq»** dögmesine basıñız ve bekleñiz. Pencerede ne qadarı yüklengeni körüne.

![Kenişletme penceresi](../docs/guide-window.png)

*Resimde — rusça interfeys. Til pencereniñ yuqarı satırında saylana: 23 til bar, qırımtatarca da bar.*

**Yüklev devam etkende** Disk saifesini kiçiltmek mümkün, amma onı **qapatmañız**. Saife qapanıp qalsa ya da kompyuter sönse — Disk'ni yañıdan açıñız ve «Devam etmek» dögmesine basıñız. Endi yüklengen fayllar kene yüklenmey.

**Fayllar qayda:** «Загрузки» → «Yandex Disk», Disktekiler kibi papkalar boyunca.

## Bir şey olmasa

| Ne körüne | Ne yapmalı |
| --- | --- |
| Mavı dögme yoq | Disk saifesini yañartıñız (F5). `chrome://extensions` içinde kenişletme açıq olğanını teşkeriñiz. |
| Brauzer er faylnı qayda saqlamaq kerek olğanını soray | 3-nci adımnı yapıñız ve «Devam etmek» basıñız. |
| Bazı fayllar «Olmadı» | Yandex serverleri şimdi episini bermey. Bir-eki saattan soñ «Olmağanlarnı tekrarlamaq» basıñız. Böyle fayllarnıñ cedvelini «Esabat (CSV)» dögmesi saqlay. |
| Kompyuterde yer az | Parçalarğa bölüngen «ZIP-arhiv», bulutqa köçürüv ya da brauzer sazlamalarında tış diskni yüklemeler papkası olaraq saylañız. |
| «Yandex teşkerüvden keçmeni rica ete» | «Teşkerüvden keçmek» basıñız, robot olmağanıñıznı tasdıqlañız, soñra «Devam etmek» basıñız. |
| Fotoresim adında «(ön baqış)» bar | Asılı berilmedi, kiçiltilgen kopiyası saqlandı. Soñra «Ön baqış yerine asıllarnı kene tecribe etmek» basıñız. |

## Bu telükesizmi?

- Kenişletme tek Yandex Disk saytında ve tek siziñ brauzeriñizde işley. Yandex parolini sormay. Fayllarıñız iç bir yerge yiberilmey — özüñiz bağlağan buluttan ğayrı.
- Bu Yandex programması degil, kodu açıq mustaqil parasız proyekt.

## Nasıl silmeli ya da yañartmalı

- **Silmek:** `chrome://extensions` → kenişletme yanındaki «Удалить». Yüklengen fayllar qalır.
- **Yañartmaq:** arhivni kene yüklep alıñız (1-nci adım), eski papkanıñ üstüne fayllarnı deñiştirip çıqarıñız, soñra `chrome://extensions` içinde kenişletme yanındaki yuvarlaq oqqa basıñız.

## Yardım kerekmi?

[Proyektniñ suallar saifesine](https://github.com/verhogladov/yandex-disk-download-all/issues) yazıñız (parasız GitHub akkauntı kerek). Ne yapqanıñıznı ve ne körgeniñizni aytıñız; skrinşot çoq yardım eter.
