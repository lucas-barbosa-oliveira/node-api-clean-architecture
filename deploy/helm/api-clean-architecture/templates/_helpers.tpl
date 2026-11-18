{{- define "api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "api.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "api.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "api.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "api.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "api.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}

{{- define "api.secretsDir" -}}/vault/secrets{{- end -}}

{{/* Nomes do certificado da API: Service, FQDN e o host que o Kong usa (<svc>.<ns>.<porta>.svc). */}}
{{- define "api.certNames" -}}
{{- $svc := include "api.fullname" . -}}
{{- $ns := .Release.Namespace -}}
{{- $names := list $svc (printf "%s.%s" $svc $ns) (printf "%s.%s.svc" $svc $ns) (printf "%s.%s.svc.cluster.local" $svc $ns) (printf "%s.%s.%v.svc" $svc $ns .Values.server.port) -}}
{{- concat $names .Values.vault.apiCert.altNames | uniq | join "," -}}
{{- end -}}

{{/*
Variáveis de ambiente da API (Deployment e job de migração). Sem ConfigMap: mudou a configuração, o template do pod
muda e o rollout acontece sozinho.
*/}}
{{- define "api.env" -}}
{{- $root := .root -}}
{{- $dir := include "api.secretsDir" $root -}}
{{- $secrets := $root.Values.vault.secrets -}}
{{- if .only }}
{{- $filtered := dict }}
{{- range $name := .only }}{{ if hasKey $secrets $name }}{{ $_ := set $filtered $name (get $secrets $name) }}{{ end }}{{ end }}
{{- $secrets = $filtered }}
{{- end -}}
{{- /* sobrescritas explícitas (o merge do Sprig ignoraria valores vazios) */}}
{{- $config := deepCopy $root.Values.config -}}
{{- range $key, $value := (default dict .overrides) }}{{ $_ := set $config $key $value }}{{ end -}}
{{- with $root -}}
{{- range $key, $value := $config }}
{{- if ne (toString $value) "" }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end }}
- name: PORT
  value: {{ .Values.server.port | quote }}
- name: HEALTH_PORT
  value: {{ .Values.server.healthPort | quote }}
- name: OTEL_METRICS_PORT
  value: {{ .Values.server.metricsPort | quote }}
- name: OTEL_SERVICE_NAME
  value: {{ .Values.config.APP_NAME | quote }}
- name: MONGO_AUTO_INDEX
  value: {{ ternary "false" "true" .Values.migrations.enabled | quote }}
{{- range $name, $var := dict "mongo-username" "MONGO_USERNAME_FILE" "mongo-password" "MONGO_PASSWORD_FILE" "rabbitmq-username" "RABBITMQ_USERNAME_FILE" "rabbitmq-password" "RABBITMQ_PASSWORD_FILE" "redis-password" "REDIS_PASSWORD_FILE" "influx-token" "INFLUX_TOKEN_FILE" "admin-password" "ADMIN_PASSWORD_FILE" }}
{{- /* a senha do admin só faz sentido com o e-mail (a API exige os dois juntos) */}}
{{- if and (hasKey $secrets $name) (or (ne $name "admin-password") $config.ADMIN_EMAIL) }}
- name: {{ $var }}
  value: {{ printf "%s/%s" $dir $name | quote }}
{{- end }}
{{- end }}
{{- if hasKey $secrets "jwt-private-key" }}
- name: JWT_PRIVATE_KEY_PATH
  value: {{ printf "%s/jwt-private-key" $dir | quote }}
- name: JWT_PUBLIC_KEY_PATH
  value: {{ printf "%s/jwt-public-key" $dir | quote }}
{{- end }}
{{- if hasKey $secrets "api-cert" }}
- name: TLS_CA_FILE
  value: {{ printf "%s/ca-cert" $dir | quote }}
- name: TLS_CLIENT_CERT_FILE
  value: {{ printf "%s/api-cert" $dir | quote }}
- name: TLS_CLIENT_KEY_FILE
  value: {{ printf "%s/api-key" $dir | quote }}
{{- end }}
{{- if and .Values.server.tls.enabled (hasKey $secrets "api-cert") }}
- name: SERVER_TLS
  value: "true"
- name: SERVER_TLS_CERT_FILE
  value: {{ printf "%s/api-cert" $dir | quote }}
- name: SERVER_TLS_KEY_FILE
  value: {{ printf "%s/api-key" $dir | quote }}
- name: SERVER_TLS_CA_FILE
  value: {{ printf "%s/ca-cert" $dir | quote }}
- name: SERVER_TLS_CLIENT_AUTH
  value: {{ .Values.server.tls.clientAuth | quote }}
- name: SERVER_TLS_MIN_VERSION
  value: {{ .Values.server.tls.minVersion | quote }}
{{- end }}
{{- if and .Values.vault.enabled .Values.vault.transit (not $.only) }}
- name: MFA_CIPHER
  value: vault-transit
- name: VAULT_ADDR
  value: "http://127.0.0.1:8200" # proxy do Vault Agent no pod (cache com o token do auto-auth)
{{- else if and .Values.secrets.existingSecret (not $.only) }}
- name: MFA_ENCRYPTION_KEY_FILE
  value: {{ printf "%s/mfa-encryption-key" $dir | quote }}
{{- end }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}
{{- end -}}

{{/* Anotações do Vault Agent Injector. "only": arquivos que o pod precisa (o job de migração usa só alguns). */}}
{{- define "api.vaultAnnotations" -}}
{{- $root := .root -}}
{{- $v := $root.Values.vault -}}
vault.hashicorp.com/agent-inject: "true"
vault.hashicorp.com/role: {{ $v.role | quote }}
vault.hashicorp.com/auth-path: {{ $v.authPath | quote }}
{{- with $v.namespace }}
vault.hashicorp.com/namespace: {{ . | quote }}
{{- end }}
vault.hashicorp.com/agent-run-as-user: "1000"
vault.hashicorp.com/agent-run-as-group: "1000"
vault.hashicorp.com/agent-requests-cpu: {{ $v.agent.cpuRequest | quote }}
vault.hashicorp.com/agent-requests-mem: {{ $v.agent.memRequest | quote }}
vault.hashicorp.com/agent-limits-cpu: {{ $v.agent.cpuLimit | quote }}
vault.hashicorp.com/agent-limits-mem: {{ $v.agent.memLimit | quote }}
{{- if .prepopulateOnly }}
vault.hashicorp.com/agent-pre-populate-only: "true"
{{- else if $v.transit }}
vault.hashicorp.com/agent-cache-enable: "true"
vault.hashicorp.com/agent-cache-use-auto-auth-token: "true"
vault.hashicorp.com/agent-cache-listener-port: "8200"
{{- end }}
{{- range $name, $path := $v.secrets }}
{{- if or (not $.only) (has $name $.only) }}
vault.hashicorp.com/agent-inject-secret-{{ $name }}: {{ $path | quote }}
vault.hashicorp.com/agent-inject-perms-{{ $name }}: "0600"
vault.hashicorp.com/agent-inject-template-{{ $name }}: |
{{- $tpl := $root.Files.Get (printf "files/vault/%s.ctmpl" $name) -}}
{{- if not $tpl }}{{ fail (printf "template files/vault/%s.ctmpl não existe" $name) }}{{ end -}}
{{- $tpl = $tpl | replace "@@API_CERT_COMMON_NAME@@" (default (printf "%s.%s.svc" (include "api.fullname" $root) $root.Release.Namespace) $v.apiCert.commonName) -}}
{{- $tpl = $tpl | replace "@@API_CERT_ALT_NAMES@@" (include "api.certNames" $root) -}}
{{- $tpl = $tpl | replace "@@API_CERT_IP_SANS@@" "" -}}
{{- $tpl = $tpl | replace "@@API_CERT_TTL@@" $v.apiCert.ttl -}}
{{- $tpl = $tpl | replace "@@KEY_PERMS@@" "0600" -}}
{{- $tpl = $tpl | replace "@@SECRETS_DIR@@" (include "api.secretsDir" $root) }}
{{ $tpl | indent 2 }}
{{- end }}
{{- end }}
{{- end -}}
