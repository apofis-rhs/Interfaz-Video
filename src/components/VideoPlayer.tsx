import { forwardRef } from 'react'

interface Props {
  src: string
}

export const VideoPlayer = forwardRef<HTMLVideoElement, Props>(function VideoPlayer({ src }, ref) {
  return (
    <div className="video-player">
      <video ref={ref} controls autoPlay src={src} className="video-player__el" />
    </div>
  )
})
