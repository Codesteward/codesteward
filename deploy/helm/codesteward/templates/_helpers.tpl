{{- define "codesteward.name" -}}
codesteward
{{- end -}}
{{- define "codesteward.labels" -}}
app.kubernetes.io/name: {{ include "codesteward.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
{{- end -}}
