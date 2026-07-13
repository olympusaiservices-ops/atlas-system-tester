{{- define "atlas-verify.name" -}}
{{- .Values.appKey | default .Chart.Name -}}
{{- end -}}

{{- define "atlas-verify.labels" -}}
app.kubernetes.io/name: {{ include "atlas-verify.name" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
