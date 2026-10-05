# 接続所有権WebSocketの生存性

調査日: 2026-08-13

## 結論

Cloudflareは、端末喪失や無通信のnetwork partitionを一定時間内に`webSocketClose()`で検知する保証も、標準のWebSocket idle timeout値も公開していない。したがって、`close`、`error`、`readyState`、`getWebSockets()`への存在だけから、相手が現在も通信可能だとは証明できない。

既存の「所有権をWebSocket接続とattachmentだけで表し、所有権recordをDurable Objects storageへ保存しない」方針は維持できる。ただし、接続を受理しただけでは所有権を有効にせず、次のapplication-level heartbeat契約が必要になる。

1. `serve`が定期的に固定文字列のheartbeat requestを送り、Durable Objectは`setWebSocketAutoResponse()`で応答する。
2. `serve`は応答を期限内に受け取れなければ、Cloudflareの`close`通知を待たずworkerと新しい外部操作を停止する。
3. Durable Objectは、新しい取得要求またはAlarm処理時に`getWebSocketAutoResponseTimestamp(ws)`を確認する。期限を過ぎた接続はattachmentを失効状態へ上書きしてからcloseし、新しい取得では無視する。
4. 旧接続から後着した確認要求は、失効済みattachmentまたは取得ID不一致として拒否する。新しい外部操作は、同じ接続上の直前確認に成功した場合だけ送る。

この方式は安全側に停止できるが、Cloudflareがmessage delivery、Alarm発火、切断検知の最大遅延を保証していないため、failover完了時間のplatform保証にはならない。

## 期限の運用値

安全条件は「server側失効期限をclient側停止期限より長くする」ことだけであり、この条件は数値の正しさではなくコードが実行時に守る。relayは`ownership.acquired`でheartbeat間隔とserver側失効期限を通知し、`serve`は自分の停止期限が失効期限以上なら所有権を取らずに停止する（`apps/serve/src/ownership-connection.ts`）。したがって既定値が構成に合わない場合、黙って所有権を持ち続けるのではなく明示的に停止する。

この検査があるため、既定値の決定に実動作測定を先行させない。現在の既定値は次の通り。

| 値 | 既定 | 置き場所 | 根拠 |
| --- | --- | --- | --- |
| heartbeat間隔 | 30秒 | relay `wrangler.jsonc` | relayが接続ごとに通知する。`serve`は設定しない |
| server側失効期限 | 90秒 | relay `wrangler.jsonc` | 間隔の3倍。heartbeat 2回の取りこぼしまで接続を維持する |
| client側停止期限 | 60秒 | `serve`の既定値 | 間隔と失効期限の間。取りこぼし1回を許容し、失効まで30秒の余裕を残す |

`serve`側は`ORIEL_OWNERSHIP_HEARTBEAT_STOP_MS`で上書きできるが、未設定でも起動する。以前は環境変数を必須にしていたが、未設定の`serve`はJobとdiscoveryを配線しないまま起動に成功するため、設定漏れが「動いているのに何も起きない」状態として現れていた。上表の既定値はその失敗様式を除くためのものであり、検証専用環境での実測後に置き換える。

なお失効までの実時間はCloudflareのAlarm発火遅延に依存し、この表の値では上限を保証できない。停止の安全性はclient側の自発停止が担い、server側失効はstale接続の掃除に留まる。

## Cloudflareが保証していること

### Hibernationと接続付随情報

- `DurableObjectState.acceptWebSocket()`で受理したWebSocketは、Durable Objectが休止してmemoryから除かれてもCloudflare network上で接続を維持する。次のeventでconstructorが再実行され、`getWebSockets()`で付随中の接続を再列挙できる。[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) [Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)
- in-memory stateは休止時に失われる。`serializeAttachment()`で保存したstructured-clone可能な値は、WebSocketがhealthyな間だけ休止を越えて接続へ付随する。どちらかがcloseすると失われ、最大サイズは16,384 bytesである。値を変更した後は再度serializeしなければ更新されない。[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- attachmentは接続喪失後の記録ではない。接続が閉じた後も必要なデータにはStorage APIが必要だが、Orielの所有権は接続中だけの一時状態なので、取得キー、device、取得ID、有効・失効状態をattachmentへ収められる。
- Hibernation APIは1 Durable Objectあたり最大32,768接続で、1接続あたりtagは最大10個、各256文字である。実用上はCPUとmemoryが先に上限になり得る。[Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)

### close、error、切断状態

- 検知済みのdisconnectでは`webSocketClose(ws, code, reason, wasClean)`が呼ばれる。`webSocketError()`はnon-disconnection error用であり、切断通知の代替ではない。[Durable Object Base Class](https://developers.cloudflare.com/durable-objects/api/base/)
- compatibility date `2026-04-07`以後は、runtimeが受信Close frameへ自動応答し、`readyState`を`CLOSED`へ移してからclose handlerを呼ぶ。それ以前はhandlerで`ws.close()`を呼ばないとclientに`1006`が生じ得る。[Durable Object Base Class](https://developers.cloudflare.com/durable-objects/api/base/) [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)
- `getWebSockets()`はdisconnect済み接続を返さないが、serverがcloseを送った後、相手のClose frameもdisconnectも検知していない`CLOSING`接続は返し得る。したがって列挙結果や`readyState`はpeer livenessの証明ではない。[Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)
- deployは既存WebSocketを切断する。Cloudflare global networkの更新でもserver restartによりWebSocketが終了し得る。またDurable Objectはnetwork partitionやruntime updateで置換され得る。[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/) [Durable Objects known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/)

### auto-responseとping/pong

- `setWebSocketAutoResponse(new WebSocketRequestResponsePair(request, response))`は、全attached WebSocketに対し、完全一致したdata messageへDurable Objectをwakeせず固定応答を返す。requestとresponseは各2,048文字までである。[Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)
- `getWebSocketAutoResponseTimestamp(ws)`は、その接続が最後にauto-responseを送った`Date`を返す。これはclientからheartbeat requestがrelayまで届いたことをserver側で監査する材料になる。[Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)
- auto-responseは受信への応答であり、自発送信、期限判定、接続closeは行わない。heartbeatのscheduleとmiss判定は`serve`および取得要求・Alarm handler側の責務である。
- WebSocket protocolのPing frameにはCloudflare runtimeが自動的にPongを返し、休止を解除しない。control frameは`webSocketMessage()`へ届かない。[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) [Durable Object Base Class](https://developers.cloudflare.com/durable-objects/api/base/)
- Workersの文書化されたWebSocket JS APIにはprotocol Pingを送るmethodやPongをapplicationへ通知するmethodがない。`send()`はdata message用である。従ってrelayの生存性契約にはprotocol pingではなくapplication-level messageを使う。[Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)

### 休止中のtimerとAlarm

- `setTimeout`または`setInterval`が残っているDurable Objectは、callbackを休止後に再構成できないためhibernateできない。休止を維持するserver-side監査には通常timerを使えない。[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- AlarmはDurable Objectを将来時刻にwakeできる。各objectで同時に1件、実行はat-least-onceで、handler失敗時は2秒からの指数backoffで最大6回retryされる。Alarm metadata自体はStorage APIで管理されるが、所有権recordを保存する必要はない。[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- Alarm handlerのwall time上限は15分である。Alarmの最大発火遅延や時刻精度SLAは公開されていないため、Alarmだけで期限内failoverを保証できない。[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- Alarmはproactiveな失効・closeには使えるが、新しい取得要求そのものもDurable Objectをwakeする。従って取得処理でtimestampを再評価すれば、Alarmが遅れていてもstorage上の所有権leaseなしでstale接続を失効させられる。

### 文書化されたその他のlimitとtimeout

- hibernate可能条件が揃うと、現在は無activity 10秒後にhibernateする。`setTimeout`等でhibernate不能なら、無activity 70–140秒後にevictionされ得る。[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- HibernationはDurable Objectがserverとして受けたWebSocketだけに対応する。outgoing WebSocketはhibernateせず、接続ごとに最大15分だけevictionを防ぐ。その後も接続自体は動作するが、eviction防止効果は失われる。[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- 受信WebSocket messageの上限は32 MiBで、超過時は`1009`でcloseされる。Durable Object invocationのCPU上限は通常30秒で、SQLite-backed classは設定により最大5分へ引き上げられる。[Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/) [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- `setHibernatableWebSocketEventTimeout()`はWebSocket event実行時間の上限を設定でき、最大7日である。これはpeerの生存性timeoutではない。[Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)
- Cloudflareは無通信のWebSocketをidle closeすると記載しているが、標準の時間は公開していない。Enterpriseはcustom timeoutを相談できる。[Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)

## Bun client側の能力

この節だけはCloudflare資料ではBun runtimeを規定できないため、Orielが固定するBunの一次資料を参照した。

- BunのclientはWeb標準形の`WebSocket`で、文書化されたinterfaceは`send()`、`close()`、`open`、`message`、`error`、`close` eventである。clientのprotocol Ping送信またはPong受信APIは文書化されていない。[Bun WebSocket client](https://bun.sh/docs/runtime/http/websockets) [Bun WebSocket interface](https://bun.sh/reference/globals/WebSocket)
- Bun server側には`sendPings`、`ping`、`pong`があるが、これは`Bun.serve()`の`ServerWebSocket` APIであり、relayへ接続するclient `WebSocket`の能力ではない。[Bun WebSockets](https://bun.sh/docs/runtime/http/websockets)
- 従って`serve`からrelayへの認証headerにはBun固有のclient constructor extensionを使えても、生存性はprotocol Pingに依存せず、通常のdata messageでheartbeat request/responseを実装するのが公開API上の最小契約である。

## 安全性と可用性の分離

### 選択肢と既存ADRへの適合

| 案 | 切断・失効の判定 | failover | ADR 0004との関係 |
| --- | --- | --- | --- |
| A. connection-only | Cloudflareが接続消失を検知し、`webSocketClose()`または`getWebSockets()`から接続が消えるまで待つ | 検知上限が非公開なのでunbounded | そのまま適合する。最も小さいが、half-open中は新規取得を待たせる |
| B. heartbeat + auto-response timestamp + Alarm/取得時監査 | clientはmissで停止し、serverは最終auto-response時刻が期限超過したsocketのattachmentを失効してcloseする | Cloudflare保証ではないが、Orielの期限policyでstale socketを無効化できる。Alarm遅延中も新規取得eventで監査可能 | 所有権recordをStorageへ置かず、接続付随情報だけを使うため適合可能。ただし「接続が物理的に残る限り所有権」と読める現行文言は、「有効なattachmentを持つ接続」へ明確化が必要 |
| C. persistent lease / epoch | Storageの期限とepochを全確認時にfenceし、期限後に新epochを発行する | socket closeを待たず論理期限でtakeoverできる。Alarmの期限内発火は不要 | 所有権recordをDurable Objects storageへ保存しない決定を変更するため不適合。bounded takeoverを強く要求する場合の別案 |

AはCloudflareが文書化した接続状態だけに依存するため安全だが、可用性に上限を置けない。Bは接続中だけのattachmentを有効・失効させるので永続leaseではなく、現在の保存境界を維持できる。Cだけが接続を越えて残る所有権recordを導入する。

### connection-only方針で守れる安全性

client側がheartbeat応答を失えば、relayが旧接続の切断をまだ検知していなくてもworkerと外部操作を止める。server側は取得要求ごとに最終auto-response時刻とattachmentを確認し、stale接続を失効して新しい取得IDを発行する。旧接続が後から通信可能になっても、失効済みattachmentでは直前確認に成功しない。

このため、storageへlease/epoch recordを置かなくても、次の条件を手元の自動試験と検証専用環境で確認すれば既存方針の安全性を維持できる。

- 取得直後から有効attachmentが存在し、休止後に同じ取得IDを復元できる。
- clientがheartbeatをmissした時点で外部操作経路をfail closedにする。
- 新規取得処理は旧接続の最終auto-response時刻を同じserver clockで評価し、失効attachmentを先にserializeしてから新規接続を有効化する。
- すべての確認requestは、そのrequestを運ぶWebSocket自身のattachmentと取得IDを照合する。別HTTP requestや別接続で確認しない。
- close/error、deploy、休止復元、同時取得、片方向partition、失効後に届く旧heartbeat・旧確認をfixtureで再現する。

### 保証できない可用性

Cloudflare資料からは、packet lossやpartition後の`close` event、heartbeat data message、Alarm、idle closeに最大遅延を置けない。従って「端末喪失からN秒以内に必ず別deviceが取得できる」というplatform保証は、この方式でも証明できない。期限はOriel自身のfailover policyであり、CloudflareのSLAではない。

Durable Objects storageへ期限付きlease/epochを保存する方式は、接続喪失後も残るfencing recordと論理時刻によるtakeoverを必要とする場合の代替案である。しかし、これはrelayへ所有権recordを保存しないという現在の境界を変え、connection-only方式の安全性に必須ではない。採用するなら別の設計判断として扱う。

## 未保証点

- 無通信partition、端末電源断、NAT状態消失をCloudflareが何秒以内にdisconnectとして検知するか。
- `webSocketClose()`またはclientの`close`/`error` eventが、あらゆるfailure modeで期限内に発火するか。
- auto-response request、response、timestamp更新のend-to-end最大遅延。
- Alarmの最大発火遅延と、障害時を含むdeadline精度。
- Cloudflare既定のWebSocket idle timeout値。
- Bun clientの下位層がprotocol Ping/PongやTCP keepaliveをどう設定するか。公開client APIに制御・観測methodはない。
- local Miniflare試験だけでproductionの実際の休止・network partition・Cloudflare server restartを再現できるか。公式資料上、古いlocal runtimeはHibernation eventを配送しても実際にはevictしなかったため、production fixtureを別途必要とする。[Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
