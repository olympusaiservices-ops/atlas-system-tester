{{- define "atlas-varify.name" -}}
{{- .Values.appKey | default .Chart.Name -}}
{{- end -}}

{{- define "atlas-varify.labels" -}}
app.kubernetes.io/name: {{ include "atlas-varify.name" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
