# Ýandeks Diskden ähli zady nädip göçürip almaly

Ýönekeý gollanma. Takmynan bäş minut wagt alýar.

*Rus dilinden terjime edildi — düzedişleri [GitHub](https://github.com/verhogladov/yandex-disk-download-all/issues) arkaly iberseňiz, şat bolarys.*

**Näme boldy.** 2026-njy ýylyň 11-nji oktýabryndan bäri Ýandeks Disk saýtynda bukjany, birnäçe faýly ýa-da tutuş Diski birden göçürip alyp bolanok — diňe birin-birin. Mugt brauzer giňeltmesi «Ýandeks Diskden ähli zady göçürip almak» «Göçürip almak» düwmesini gaýtarýar: ol faýllary birin-birin özi göçürýär we Diskdäki ýaly bukjalara ýerleşdirýär.

**Näme gerek:**

- kompýuter ýa-da noutbuk (Windows, macOS ýa-da Linux);
- Google Chrome ýa-da Ýandeks Brauzer (Edge, Opera, Brave, Vivaldi hem bolýar);
- kompýuterde boş ýer — takmynan Diskde näçe ýer eýelenen bolsa, şonça.

Telefonda işlemeýär: mobil brauzerlere beýle giňeltme gurnalmaýar. Kompýuter gerek.

## 1-nji ädim. Giňeltmäni göçürip alyň

1. Basyň: **[yandex-disk-download-all.zip göçürip almak](https://github.com/verhogladov/yandex-disk-download-all/releases/latest/download/yandex-disk-download-all.zip)**. Faýl «Загрузки» (Göçürilenler) bukjasyna saklanar.
2. Ony arhiwden çykaryň:
   - **Windows:** faýla syçanyň sag düwmesi bilen basyň → «Извлечь все…» (Hemmesini çykarmak) → «Извлечь»;
   - **macOS:** faýla iki gezek basyň.
3. `yandex-disk-download-all` bukjasy peýda bolar. Ony päsgel bermejek ýere, meselem «Документы» bukjasyna geçiriň. Soňra pozmaň: brauzer giňeltmäni şu bukjadan alýar.

## 2-nji ädim. Giňeltmäni brauzere guruň

**Google Chrome**

1. Salgy setirine `chrome://extensions` ýazyň we Enter basyň.
2. Ýokarky sag burçda **«Режим разработчика»** (işläp düzüjiniň tertibi, iňlisçe Developer mode) wyklýuçatelini açyň.
3. Ýokarky çep burçdaky birinji düwmä basyň — **«Загрузить распакованное расширение»** (açylan giňeltmäni ýüklemek, iňlisçe Load unpacked).
   ![«Режим разработчика» (1) we «Загрузить распакованное расширение» (2) nirede](../docs/guide-extensions.png)
4. `yandex-disk-download-all` bukjasyny saýlaň (içinde `manifest.json` faýly bolan bukja).
5. Sanawda giňeltme peýda bolar. Taýýar.

**Ýandeks Brauzer** — edil şeýle, diňe salgysy `browser://extensions`.

**Edge, Opera, Brave, Vivaldi** — salgylary `edge://extensions`, `opera://extensions`, `brave://extensions`, `vivaldi://extensions`, soňra edil şeýle: «Режим разработчика» → «Загрузить распакованное».

> «Режим разработчика» — bu adaty zat: dükandan däl giňeltmeler şeýle gurulýar. Giňeltme mugt, kody açyk. Eger brauzer işe başlanda beýle giňeltmeleri öçürmegi teklip etse — ret ediň.

## 3-nji ädim. «Nirä saklamaly» soragyny öçüriň

Ýogsa brauzer her faýl hakda sorar, olar bolsa müňlerçe bolup biler.

- **Chrome:** `chrome://settings/downloads` açyň we **«Перед скачиванием спрашивать, куда сохранить файл»** (her faýly nirä saklamalydygyny soramak) öçüriň.
  ![Wyklýuçatel öçük bolmaly](../docs/guide-downloads.png)
- **Ýandeks Brauzer:** «Настройки» → «Инструменты» → «Загруженные файлы» → **«Всегда спрашивать, куда сохранять файлы»** belgisini aýyryň.
- **Beýleki brauzerler:** sazlamalaryň göçürmeler bölüminde her faýly nirä saklamak baradaky soragy öçüriň.

## 4-nji ädim. Faýllary göçürip alyň

1. [disk.yandex.ru](https://disk.yandex.ru) açyň we hasabyňyza giriň. Disk öňden açyk bolsa — sahypany täzeläň (F5).
2. Aşaky sag burçda gök **«Tutuş Diski göçürip almak»** düwmesi peýda bolar. Bukjanyň içinde ol «Bukjany göçürip almak» diýip atlandyrylýar, faýllary belleseňiz — «Bellenenleri göçürip almak».
   ![Diskdäki gök düwme](../docs/guide-button.png)
3. Oňa basyň. Penjire açylar:
   - **«Näme göçürmeli»** — tutuş Disk, şu bukja, bellenenler ýa-da sanawdan «Faýllary we bukjalary saýlamak…»;
   - **«Haýsy faýllar»** — hemmesi ýa-da «Diňe gerekli görnüşler» (meselem, diňe suratlar we wideo);
   - **«Nirä saklamaly»** — kompýutere Diskdäki ýaly faýllar görnüşinde, bir ZIP-arhiw görnüşinde ýa-da başga bulut ammaryna.
4. **«Göçürmäge başlamak»** düwmesine basyň we garaşyň. Penjirede näçesiniň göçürilendigi görünýär.

![Giňeltmäniň penjiresi](../docs/guide-window.png)

*Suratda — rusça interfeýs. Dil penjiräniň ýokarky setirinde saýlanýar: 23 dil bar, türkmençe hem.*

**Göçürme dowam edýärkä** Disk goýmasyny ýygnap bolýar, ýöne ony **ýapmaň**. Goýma ýapylsa ýa-da kompýuter öçse — Diski täzeden açyň we «Dowam etmek» düwmesine basyň. Eýýäm göçürilen faýllar täzeden göçürilmeýär.

**Faýllar nirede:** «Загрузки» → «Yandex Disk», Diskdäki ýaly bukjalar boýunça.

## Bir zat başartmasa

| Näme görünýär | Näme etmeli |
| --- | --- |
| Gök düwme ýok | Disk sahypasyny täzeläň (F5). `chrome://extensions` içinde giňeltmäniň açykdygyny barlaň. |
| Brauzer her faýly nirä saklamalydygyny soraýar | 3-nji ädimi ýerine ýetiriň we «Dowam etmek» basyň. |
| Käbir faýllar «Başartmady» | Ýandeks serwerleri häzir hemmesini bermeýär. Bir-iki sagatdan «Başartmadyklaryny gaýtalamak» basyň. Şeýle faýllaryň sanawyny «Hasabat (CSV)» düwmesi saklaýar. |
| Kompýuterde ýer az | Böleklere bölünen «ZIP-arhiw», bulut ammaryna geçirmek ýa-da brauzer sazlamalarynda daşky diski göçürmeler bukjasy hökmünde saýlaň. |
| «Ýandeks barlagdan geçmegi soraýar» | «Barlagdan geçmek» basyň, robot däldigiňizi tassyklaň, soňra «Dowam etmek» basyň. |
| Suratyň adynda «(öňünden görnüş)» bar | Asyl nusga berilmedi, kiçeldilen nusgasy saklandy. Soňra «Öňünden görnüşiň ýerine asyl nusgalary ýene synap görmek» basyň. |

## Bu howpsuzmy?

- Giňeltme diňe Ýandeks Disk saýtynda we diňe siziň brauzeriňizde işleýär. Ýandeks parolyny soramaýar. Faýllaryňyz hiç ýere iberilmeýär — özüňiz birikdiren bulut ammaryndan başga.
- Bu Ýandeksiň programmasy däl, kody açyk garaşsyz mugt taslama.

## Nädip aýyrmaly ýa-da täzelemeli

- **Aýyrmak:** `chrome://extensions` → giňeltmäniň ýanyndaky «Удалить». Göçürilen faýllar galar.
- **Täzelemek:** arhiwi täzeden göçürip alyň (1-nji ädim), köne bukjanyň üstüne faýllary çalşyp çykaryň, soňra `chrome://extensions` içinde giňeltmäniň ýanyndaky tegelek peýkamy basyň.

## Kömek gerekmi?

[Taslamanyň soraglar sahypasyna](https://github.com/verhogladov/yandex-disk-download-all/issues) ýazyň (mugt GitHub hasaby gerek). Näme edeniňizi we näme görendigiňizi ýazyň; skrinşot köp kömek eder.
